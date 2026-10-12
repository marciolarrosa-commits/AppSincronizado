'use strict';
// Hub de tiempo real: registro de conexiones por sesión, heartbeat, difusión de estado, contrapresión,
// presencia, confirmaciones de aplicación y apagado ordenado. Es independiente del transporte HTTP.
const crypto = require('crypto');
const WebSocket = require('ws');
const P = require('./protocol');
const { TokenBucket } = require('./ratelimit');
const { ackBucket } = require('./store/common');

const CLOSE = {
  PROTOCOL: 1008,
  RESTART: 1012,          // reinicio/despliegue del servidor: el cliente debe reconectar con jitter
  TRY_LATER: 1013,
  NOT_FOUND: 4404,        // sesión inexistente o vencida: no reintentar
  UNAUTHORIZED: 4401,     // token inválido o revocado: no reintentar
  DEVICE_REPLACED: 4002,  // el mismo dispositivo abrió otra conexión: no reintentar
  RATE_LIMITED: 4429,
  HELLO_TIMEOUT: 4408,
  SLOW: 4413              // consumidor demasiado lento
};

const rid = n => crypto.randomBytes(n).toString('hex');
const nowMs = () => Date.now();

function createHub({ config, store, metrics, logger, auth, getHealth, clock }) {
  const nowMs = () => (clock ? clock.now() : Date.now());          // hora de servidor (única entre instancias cuando hay almacenamiento compartido)
  const rooms = new Map();
  const buckets = Array.from({ length: Math.max(1, Math.round(config.heartbeatMs / 1000)) }, () => new Set());
  const needResync = new Set();
  const recentBroadcast = [];          // últimas duraciones del bucle de difusión (ms), para calcular el margen adaptativo
  const ipConns = new Map();           // ip -> {pre, total}: conexiones sin hello / totales (límites por capas)
  let nextBucket = 0;
  let tick = 0;
  let connCount = 0;
  let draining = false;
  let presenceBusy = false;
  const timers = [];
  const limits = {
    maxLeadMs: config.maxLeadMs, maxStrobeHz: config.maxStrobeHz,
    maxStrobeDurationMs: config.maxStrobeDurationMs, maxPulseDurationMs: config.maxPulseDurationMs
  };

  // ------------------------------------------------------------------ envío con contrapresión
  function sendRaw(conn, raw) {
    const ws = conn.ws;
    if (ws.readyState !== WebSocket.OPEN) return false;
    const buffered = ws.bufferedAmount;
    if (buffered > config.bufferHardBytes) { metrics.inc('ws_slow_closed'); closeConn(conn, CLOSE.SLOW, 'SLOW_CONSUMER', true); return false; }
    if (buffered > config.bufferSoftBytes) {
      // El estado más nuevo reemplaza al anterior: se omite el envío y se reenvía el estado vigente cuando se libere el buffer.
      conn.strikes++; metrics.inc('ws_backpressure_skips');
      if (conn.strikes >= config.slowStrikes) { metrics.inc('ws_slow_closed'); closeConn(conn, CLOSE.SLOW, 'SLOW_CONSUMER', true); return false; }
      needResync.add(conn);
      return false;
    }
    try { ws.send(raw, { compress: false }); metrics.inc('messages_out'); metrics.inc('bytes_out', raw.length); return true; }
    catch { metrics.inc('ws_send_errors'); return false; }
  }
  // Compatibilidad V3.0 (solo participantes): páginas abiertas antes del despliegue se conectan con /ws?session=..&role=public
  // y esperan los mensajes antiguos (hello/state/pong). Se traducen aquí; el Master antiguo NO es compatible (ahora exige autenticación).
  function legacyState(st) {
    const p = st.payload;
    return { version: st.stateVersion, color: p.color, effect: p.effect === 'strobe' || p.effect === 'pulse' ? p.effect : 'solid', intensity: p.intensity, executeAt: st.executeAt, active: p.effect !== 'off', label: 'Master' };
  }
  function toLegacy(obj, room) {
    const connected = room ? Math.max(room.publics.size, room.globalTotal || 0) : 0;
    if (obj.type === 'welcome') return { type: 'hello', role: 'public', session: obj.sessionId, deviceId: obj.deviceId, serverTime: obj.serverTimestamp, connected, state: legacyState(obj.state) };
    if (obj.type === 'state') return { type: 'state', session: obj.sessionId, state: legacyState(obj), serverTime: obj.serverTimestamp, connected };
    if (obj.type === 'pong') return { type: 'pong', clientTime: obj.clientTime, serverTime: obj.serverTimestamp };
    return null;
  }
  const send = (conn, obj) => {
    if (conn.legacy) { const l = toLegacy(obj, conn.room); return l ? sendRaw(conn, JSON.stringify(l)) : false; }
    return sendRaw(conn, JSON.stringify(obj));
  };

  function closeConn(conn, code, reason, terminate = false) {
    if (conn.closed) return;
    try { terminate ? conn.ws.terminate() : conn.ws.close(code, reason); } catch { /* ya cerrado */ }
  }

  // ------------------------------------------------------------------ salas
  async function ensureRoom(id) {
    let room = rooms.get(id);
    if (room) { await room.ready; return room; }
    room = {
      id, publics: new Map(), masters: new Set(), latest: null, strobeEnabled: false, unsub: null, ready: null,
      globalTotal: 0, lastPresenceSent: -1, lastPresenceSentAt: 0, lastPresenceSet: -1, lastPresenceSetAt: 0,
      statsTimer: null, statsTicks: 0, statsVersion: -1, lastDeliverVersion: -1, knownVersion: -1
    };
    rooms.set(id, room);
    // Primero suscribirse y recién después leer el estado: así no se puede perder una orden entre ambas operaciones.
    room.unsub = store.subscribe(id, msg => onBus(room, msg), () => reconcileRoom(room));
    room.ready = Promise.resolve(room.unsub.ready);
    try { await room.ready; } catch (e) { rooms.delete(id); throw e; }
    return room;
  }

  async function maybeDropRoom(room) {
    if (room.publics.size || room.masters.size || rooms.get(room.id) !== room) return;
    rooms.delete(room.id);
    if (room.statsTimer) clearInterval(room.statsTimer);
    try { await room.unsub(); } catch { /* cerrando */ }
    store.presenceSet(room.id, config.instanceId, 0).catch(() => {});
  }

  // Si la sesión se perdió y se re-creó con el mismo código (p. ej. el almacenamiento compartido se reinició con la app viva), las versiones
  // vuelven a empezar: sin esto el hub descartaría TODAS las órdenes nuevas como "viejas" (el Master vería "aceptada" pero nadie recibiría nada).
  function syncIncarnation(room, inc) {
    if (inc === undefined || inc === room.incarnation) return;
    if (room.incarnation !== undefined) { logger.warn('session_incarnation_changed', { sessionId: room.id }); metrics.inc('session_incarnation_changes'); room.lastDeliverVersion = -1; room.knownVersion = -1; room.latest = null; if (room.cmdByVersion) room.cmdByVersion.clear(); }
    room.incarnation = inc;
  }

  // Reconciliación: si el almacenamiento tiene un estado MÁS NUEVO que el último entregado (mensaje de pub/sub perdido, suscriptor caído o sesión
  // re-creada), se entrega el vigente. Los clientes lo aplican de inmediato (su executeAt ya pasó) o lo programan.
  async function reconcileRoom(room) {
    if (rooms.get(room.id) !== room) return;
    const sess = await store.getSession(room.id);
    if (!sess || rooms.get(room.id) !== room) return;
    const st = sess.state;
    if (st.incarnation !== room.incarnation || st.stateVersion > room.knownVersion) {
      metrics.inc('reconciled_states'); logger.warn('state_reconciled', { sessionId: room.id, stateVersion: st.stateVersion });
      onBus(room, { k: 'state', s: st });
    }
  }
  let reconcileBusy = false;
  async function reconcileTick() {
    if (reconcileBusy) return;
    reconcileBusy = true;
    try { for (const room of [...rooms.values()]) await reconcileRoom(room); }
    catch (e) { metrics.inc('store_errors'); logger.warn('reconcile_failed', { error: e.message }); }
    finally { reconcileBusy = false; }
  }

  function onBus(room, msg) {
    if (!msg || msg.k !== 'state' || !msg.s) return;
    const st = msg.s;
    syncIncarnation(room, st.incarnation);
    if (st.stateVersion > room.knownVersion) room.knownVersion = st.stateVersion;
    if (!room.latest || st.stateVersion > room.latest.stateVersion) room.latest = st;
    rememberCommand(room, st);
    deliver(room, st);
    if (room.masters.size) scheduleStats(room, st);
  }

  // commandId de las últimas versiones (acotado): sirve para validar que una confirmación 'applied' corresponde a la orden de esa versión.
  function rememberCommand(room, st) {
    if (!room.cmdByVersion) room.cmdByVersion = new Map();
    room.cmdByVersion.set(st.stateVersion, st.commandId);
    if (room.cmdByVersion.size > 12) room.cmdByVersion.delete(room.cmdByVersion.keys().next().value);
  }

  // Difunde UNA orden a todos los dispositivos locales de la sesión (serializada una sola vez, en lotes para no bloquear el event loop).
  function deliver(room, state) {
    if (state.stateVersion <= room.lastDeliverVersion) return;   // duplicado/obsoleto en el bus
    room.lastDeliverVersion = state.stateVersion;
    const t0 = nowMs();
    metrics.observe('publishMs', Math.max(0, t0 - state.serverTimestamp));
    const total = Math.max(room.publics.size, room.globalTotal || 0, 1);
    const ackRate = Math.round(Math.min(1, config.ackTargetPerCommand / total) * 10000) / 10000;
    const raw = JSON.stringify(P.server.state(room.id, state, { ackRate }));
    const targets = [...room.masters, ...room.publics.values()];
    let legacyRaw = null;
    const rawFor = c => { if (!c.legacy) return raw; return legacyRaw || (legacyRaw = JSON.stringify(toLegacy(P.server.state(room.id, state), room))); };
    let i = 0; let sent = 0;
    const step = () => {
      const end = Math.min(targets.length, i + config.broadcastChunk);
      for (; i < end; i++) if (sendRaw(targets[i], rawFor(targets[i]))) sent++;
      if (i < targets.length) return setImmediate(step);
      const dur = nowMs() - t0;
      metrics.observe('broadcastMs', dur);
      recentBroadcast.push(dur); if (recentBroadcast.length > 50) recentBroadcast.shift();
      metrics.inc('state_broadcasts');
      metrics.setGauge('last_broadcast_targets', targets.length);
    };
    step();
  }

  // Margen de ejecución efectivo: lo pedido (o el predeterminado), nunca menor que el tiempo real de difusión observado.
  function effectiveLead(requested) {
    let lead = requested == null ? config.defaultLeadMs : requested;
    const sorted = [...recentBroadcast].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    lead = Math.max(lead, Math.ceil(p95 * 2) + 250, config.minLeadMs);
    return Math.min(lead, config.maxLeadMs);
  }

  // ------------------------------------------------------------------ ciclo de vida de conexiones
  function accept(ws, req, ip, legacy) {
    const conn = {
      id: rid(6), ws, ip, role: null, sessionId: null, deviceId: null, room: null, epoch: null,
      legacy: legacy || null, joined: false, joining: false, closed: false, alive: true, bucket: nextBucket++ % buckets.length,
      strikes: 0, violations: 0, protoErrors: 0, lastErrorAt: 0, limiter: null, connectedAt: nowMs(), helloTimer: null,
      log: logger.child({ connId: rid(4), ip })
    };
    connCount++; metrics.inc('ws_connections_total'); metrics.setGauge('connections_total', connCount);
    { const c = ipConns.get(ip) || { pre: 0, total: 0 }; c.pre++; c.total++; ipConns.set(ip, c); conn.counted = true; conn.preCounted = true; }
    buckets[conn.bucket].add(conn);
    // El vencimiento del hello NO cuenta como unión fallida: en una red saturada teléfonos legítimos tardan, y sumarlo al límite por IP bloquearía a todo el NAT
    // que la comparte (realimentación). Se cuenta aparte (ws_hello_timeouts); lo limita la capa de conexiones sin hello por IP.
    conn.helloTimer = setTimeout(() => { metrics.inc('ws_hello_timeouts'); closeConn(conn, CLOSE.HELLO_TIMEOUT, 'HELLO_TIMEOUT'); }, config.helloTimeoutMs);

    ws.on('message', (data, isBinary) => onMessage(conn, data, isBinary));
    ws.on('pong', () => { conn.alive = true; });
    ws.on('error', e => { metrics.inc('ws_errors'); conn.log.debug('ws_error', { error: e.message }); });
    ws.on('close', (code) => onClose(conn, code));
    if (conn.legacy) {
      conn.joining = true;
      join(conn, { role: 'public', sessionId: conn.legacy.sessionId, deviceId: conn.legacy.deviceId, resumeVersion: 0, reconnect: true })
        .catch(() => closeConn(conn, CLOSE.TRY_LATER, 'UNAVAILABLE'));
    }
    return conn;
  }

  function onClose(conn, code) {
    conn.closed = true;
    clearTimeout(conn.helloTimer);
    buckets[conn.bucket].delete(conn);
    needResync.delete(conn);
    connCount--; metrics.setGauge('connections_total', connCount);
    metrics.inc('ws_disconnections_total');
    ipRelease(conn);
    const room = conn.room;
    if (room) {
      if (conn.role === 'master') room.masters.delete(conn);
      else if (room.publics.get(conn.deviceId) === conn) room.publics.delete(conn.deviceId);
      maybeDropRoom(room);
    }
  }

  function ipRelease(conn) {
    const c = ipConns.get(conn.ip); if (!c) return;
    if (conn.preCounted) { conn.preCounted = false; c.pre--; }
    if (conn.counted) { conn.counted = false; c.total--; }
    if (c.total <= 0) ipConns.delete(conn.ip);
  }

  // Error de protocolo hacia el cliente. Si está asociado a una ORDEN concreta (commandId válido) se responde siempre —el panel lo necesita para
  // cerrar esa orden—, pero con un presupuesto por conexión (errLimiter) para que un cliente defectuoso no genere un torrente de respuestas.
  // Los errores SIN commandId siguen limitados a 1 por segundo (no hay a quién asociarlos y no deben amplificar). Nunca se inventa un commandId.
  function protoError(conn, e, commandId) {
    metrics.inc('protocol_errors');
    const code = e.code || 'INVALID_MESSAGE';
    conn.protoErrors++;
    const t = nowMs();
    const id = P.safeCommandId(commandId);
    if (id) {
      if (conn.errLimiter ? conn.errLimiter.take() : true) { if (!send(conn, P.server.error(code, e.message, { commandId: id }))) metrics.inc('replies_undeliverable'); }
      else metrics.inc('error_replies_suppressed');
    } else if (t - conn.lastErrorAt > 1000) { conn.lastErrorAt = t; send(conn, P.server.error(code, e.message)); }
    if (conn.protoErrors >= 8) { conn.onBadJoin && conn.onBadJoin(); closeConn(conn, CLOSE.PROTOCOL, 'TOO_MANY_ERRORS'); }
  }

  // Un Master superó el límite general de mensajes. Si lo descartado era una orden de CONTROL con commandId válido se le avisa (RATE_LIMITED + commandId)
  // para que el panel cierre esa orden en vez de dejarla "enviando"; la telemetría (ping/applied) y todo lo no asociable a una orden se descarta
  // sin responder. Las respuestas tienen su propio presupuesto (rlReplyLimiter): si se agota, se descarta en silencio y el panel resuelve por timeout.
  function replyRateLimited(conn, data) {
    const ctl = conn.role === 'master' ? P.peekControl(data, config.maxMessageBytes) : null;
    if (!ctl) { metrics.inc('rate_limited_unanswered'); return; }
    if (!ctl.commandId) { metrics.inc('rate_limited_unanswerable'); conn.log.debug('rate_limited_control_without_id', { type: ctl.type }); return; }
    if (!conn.rlReplyLimiter || !conn.rlReplyLimiter.take()) { metrics.inc('rate_limited_replies_suppressed'); return; }
    if (send(conn, P.server.error('RATE_LIMITED', 'Demasiados mensajes por segundo: la orden no se procesó', { commandId: ctl.commandId }))) metrics.inc('rate_limited_replies');
    else metrics.inc('replies_undeliverable');
  }

  function onMessage(conn, data, isBinary) {
    if (isBinary) { metrics.inc('protocol_errors'); return closeConn(conn, 1003, 'BINARY_NOT_SUPPORTED'); }
    conn.alive = true;
    metrics.inc('messages_in');
    if (conn.legacy) {
      if (conn.limiter && !conn.limiter.take()) return;
      try { const m = JSON.parse(data.toString()); if (m && m.type === 'ping') send(conn, { type: 'pong', clientTime: m.clientTime, serverTimestamp: nowMs() }); } catch { /* se ignora */ }
      return;
    }
    if (conn.limiter && !conn.limiter.take()) {
      metrics.inc('rate_limited');
      conn.violations++;
      replyRateLimited(conn, data);              // órdenes de control con commandId: respuesta acotada; el resto se descarta sin responder
      if (conn.violations >= 20) closeConn(conn, CLOSE.RATE_LIMITED, 'RATE_LIMITED');
      return;
    }
    let msg;
    try { msg = P.parseEnvelope(data, config.maxMessageBytes); }
    catch (e) { const ctl = conn.role === 'master' ? P.peekControl(data, config.maxMessageBytes) : null; return protoError(conn, e, ctl && ctl.commandId); }

    if (!conn.joined) {
      if (msg.type !== 'hello') { protoError(conn, new P.ProtocolError('NOT_JOINED', 'Primero hay que enviar hello')); return closeConn(conn, CLOSE.PROTOCOL, 'NOT_JOINED'); }
      if (conn.joining) return;
      conn.joining = true;
      let hello;
      try { hello = P.validateHello(msg); } catch (e) { protoError(conn, e); return closeConn(conn, CLOSE.PROTOCOL, e.code); }
      return join(conn, hello).catch(e => {
        logger.error('join_failed', { error: e.message });
        send(conn, P.server.error('UNAVAILABLE', 'Servicio no disponible, reintentá'));
        closeConn(conn, CLOSE.TRY_LATER, 'UNAVAILABLE');
      });
    }

    try {
      switch (msg.type) {
        case 'hello': throw new P.ProtocolError('ALREADY_JOINED', 'Ya estás conectado');
        case 'ping': { const { t0, rtt } = P.validatePing(msg); if (rtt != null) metrics.observe('clockRttMs', rtt); return send(conn, P.server.pong(t0, nowMs())); }
        case 'applied':
          if (conn.role !== 'public') throw new P.ProtocolError('FORBIDDEN', 'Solo los participantes confirman aplicación');
          return handleApplied(conn, P.validateApplied(msg));
        case 'command': case 'stop': case 'setConfig':
          if (conn.role !== 'master') { metrics.inc('forbidden_commands'); throw new P.ProtocolError('FORBIDDEN', 'No autorizado'); }
          return handleMasterMessage(conn, msg);
        default: throw new P.ProtocolError('UNKNOWN_TYPE', 'Tipo desconocido');
      }
    } catch (e) {
      if (e instanceof P.ProtocolError) return protoError(conn, e);
      logger.error('message_failed', { type: msg.type, error: e.message });
      send(conn, P.server.error('INTERNAL', 'Error interno'));
    }
  }

  function reject(conn, code, wsCode, message, commandId) {
    metrics.inc('ws_rejected_' + code.toLowerCase());
    send(conn, P.server.error(code, message, commandId ? { commandId } : undefined));
    closeConn(conn, wsCode, code);
  }

  async function join(conn, h) {
    if (draining) return reject(conn, 'DRAINING', CLOSE.TRY_LATER, 'Servidor reiniciando');
    // Una sesión que no existe se rechaza ANTES de crear la sala y suscribirse al canal: un hello a un código inventado no debe costar una suscripción/baja en
    // Redis. Solo hace falta comprobarlo cuando no hay ya una sala local (si la hay, la sesión existe o se verifica abajo como siempre).
    if (!rooms.has(h.sessionId) && !(await store.sessionExists(h.sessionId))) {
      metrics.inc('bad_join'); conn.onBadJoin && conn.onBadJoin();
      return reject(conn, 'SESSION_NOT_FOUND', CLOSE.NOT_FOUND, 'Sesión inexistente o vencida');
    }
    const room = await ensureRoom(h.sessionId);
    if (conn.closed) return maybeDropRoom(room);
    const sess = await store.getSession(h.sessionId);
    if (conn.closed) return maybeDropRoom(room);
    if (!sess) { await maybeDropRoom(room); metrics.inc('bad_join'); conn.onBadJoin && conn.onBadJoin(); return reject(conn, 'SESSION_NOT_FOUND', CLOSE.NOT_FOUND, 'Sesión inexistente o vencida'); }

    if (h.role === 'master') {
      const tok = auth.verifyMaster(h.token, sess.id);
      if (!tok || tok.ep !== sess.epoch) { await maybeDropRoom(room); metrics.inc('unauthorized_master'); conn.onBadJoin && conn.onBadJoin(); return reject(conn, 'UNAUTHORIZED', CLOSE.UNAUTHORIZED, 'Token inválido o vencido'); }
      if (room.masters.size >= config.maxMastersPerSession) return reject(conn, 'TOO_MANY_MASTERS', CLOSE.TRY_LATER, 'Demasiados paneles Master');
      conn.role = 'master'; conn.epoch = sess.epoch; conn.deviceId = 'master-' + conn.id;
      conn.limiter = new TokenBucket(config.masterCommandsPerSec * 4, config.masterCommandBurst * 4);   // además de los comandos, pings
      conn.cmdLimiter = new TokenBucket(config.masterCommandsPerSec, config.masterCommandBurst);
      conn.errLimiter = new TokenBucket(config.masterCommandsPerSec * 4, config.masterCommandBurst * 4);   // respuestas de error asociadas a una orden
      conn.rlReplyLimiter = new TokenBucket(2, 4);                                                        // respuestas «RATE_LIMITED» (más estrictas: no agravar la saturación)
      room.masters.add(conn);
    } else {
      if (room.publics.size >= config.maxPublicPerSession) return reject(conn, 'SESSION_FULL', CLOSE.TRY_LATER, 'Sesión completa');
      conn.role = 'public';
      conn.deviceId = h.deviceId || crypto.randomUUID();
      conn.limiter = new TokenBucket(config.publicMsgPerSec, config.publicMsgBurst);
      const prev = room.publics.get(conn.deviceId);
      if (prev && prev !== conn) { metrics.inc('device_replaced'); send(prev, P.server.error('DEVICE_REPLACED', 'Este dispositivo se conectó desde otra pestaña')); closeConn(prev, CLOSE.DEVICE_REPLACED, 'DEVICE_REPLACED'); }
      room.publics.set(conn.deviceId, conn);
    }
    conn.sessionId = sess.id; conn.room = room; conn.joined = true;
    clearTimeout(conn.helloTimer);
    if (conn.preCounted) { conn.preCounted = false; const c = ipConns.get(conn.ip); if (c) c.pre--; }
    if (h.reconnect) metrics.inc('reconnects');
    room.strobeEnabled = sess.strobeEnabled;
    syncIncarnation(room, sess.state.incarnation);
    if (sess.state.stateVersion > room.knownVersion) room.knownVersion = sess.state.stateVersion;      // lo informa el welcome; NO toca lastDeliverVersion (la difusión en curso sigue su curso)
    if (!room.latest || sess.state.stateVersion >= room.latest.stateVersion) { room.latest = sess.state; rememberCommand(room, sess.state); }
    store.touchSession(sess.id).catch(() => {});

    send(conn, P.server.welcome({
      serverTimestamp: nowMs(), sessionId: sess.id, role: conn.role, deviceId: conn.deviceId,
      state: room.latest,
      config: {
        heartbeatMs: config.heartbeatMs, clockPingIntervalMs: config.clockPingIntervalMs, onTimeToleranceMs: config.onTimeToleranceMs,
        minLeadMs: config.minLeadMs, maxStrobeHz: config.maxStrobeHz, strobeEnabled: sess.strobeEnabled && config.strobeAllowed,
        strobeAllowed: config.strobeAllowed, maxStrobeDurationMs: config.maxStrobeDurationMs
      },
      ...(conn.role === 'master' ? { connected: Math.max(room.publics.size, room.globalTotal) } : {})
    }));
    conn.log.debug('joined', { sessionId: sess.id, role: conn.role });
  }

  // ------------------------------------------------------------------ comandos del Master
  // Envoltorio: cualquier fallo del almacenamiento compartido se informa al Master sin dejar promesas sin atrapar.
  function handleMasterMessage(conn, msg) {
    return handleMasterMessageInner(conn, msg).catch(e => {
      metrics.inc('commands_failed'); metrics.inc('store_errors');
      logger.error('master_message_failed', { sessionId: conn.sessionId, type: msg.type, error: e.message });
      send(conn, P.server.error('PUBLISH_FAILED', 'No se pudo procesar la orden (almacenamiento no disponible), reintentá', { commandId: msg.commandId }));
    });
  }

  async function handleMasterMessageInner(conn, msg) {
    const room = conn.room;
    const sess = await store.getSession(conn.sessionId);
    if (!sess) return reject(conn, 'SESSION_NOT_FOUND', CLOSE.NOT_FOUND, 'La sesión terminó', P.safeCommandId(msg.commandId));
    if (sess.epoch !== conn.epoch) { metrics.inc('unauthorized_master'); return reject(conn, 'UNAUTHORIZED', CLOSE.UNAUTHORIZED, 'Token revocado', P.safeCommandId(msg.commandId)); }
    room.strobeEnabled = sess.strobeEnabled;

    try {
      if (msg.type === 'setConfig') {
        const c = P.validateSetConfig(msg);
        if (c.strobeEnabled && !config.strobeAllowed) throw new P.ProtocolError('STROBE_DISABLED', 'El strobe está deshabilitado en este servidor');
        await store.setStrobe(conn.sessionId, c.strobeEnabled);
        room.strobeEnabled = c.strobeEnabled;
        logger.info('strobe_config', { sessionId: conn.sessionId, enabled: c.strobeEnabled });
        // se avisa a todos los paneles Master locales
        for (const m of room.masters) send(m, { protocolVersion: P.PROTOCOL_VERSION, type: 'config', strobeEnabled: c.strobeEnabled && config.strobeAllowed, serverTimestamp: nowMs() });
        return;
      }

      const ts = nowMs();
      let cmd; let executeAt; let payload; let commandId;
      if (msg.type === 'stop') {
        // Parada de emergencia: prioritaria (no consume cupo de frecuencia), se ejecuta de inmediato y vuelve al estado seguro (pantalla apagada).
        const s = P.validateStop(msg);
        commandId = s.commandId || 'c' + rid(8);
        payload = { effect: 'off', color: '#000000', color2: '#000000', intensity: 1 };
        executeAt = ts; metrics.inc('stop_commands');
      } else {
        if (!conn.cmdLimiter.take()) { metrics.inc('rate_limited_commands'); throw new P.ProtocolError('RATE_LIMITED', 'Demasiadas órdenes por segundo'); }
        cmd = P.validateCommand(msg, limits);
        if (cmd.payload.effect === 'strobe' && !(sess.strobeEnabled && config.strobeAllowed)) throw new P.ProtocolError('STROBE_DISABLED', 'El strobe está deshabilitado: habilitalo en el panel confirmando la advertencia');
        if (cmd.payload.effect === 'sequence') {
          // Un paso de menos de 1 s equivale a un parpadeo (hasta 2 Hz): se trata como strobe (habilitación explícita con la advertencia) y nunca supera la frecuencia máxima.
          const minHold = Math.min(...cmd.payload.steps.map(st => st.holdMs));
          if (1000 / minHold > config.maxStrobeHz) throw new P.ProtocolError('OUT_OF_RANGE', 'Los cambios de color son demasiado rápidos (máx. ' + config.maxStrobeHz + ' por segundo)');
          if (minHold < 1000 && !(sess.strobeEnabled && config.strobeAllowed)) throw new P.ProtocolError('STROBE_DISABLED', 'Un paso de la secuencia dura menos de 1 s: se considera intermitente y exige habilitar el strobe con la advertencia de fotosensibilidad');
        }
        commandId = cmd.commandId || 'c' + rid(8);
        payload = cmd.payload;
        executeAt = ts + effectiveLead(cmd.leadMs);
      }
      const t0 = nowMs();
      const res = await store.applyState(conn.sessionId, { commandId, executeAt, serverTimestamp: ts, payload });
      metrics.observe('storeMs', nowMs() - t0);
      if (!res) return reject(conn, 'SESSION_NOT_FOUND', CLOSE.NOT_FOUND, 'La sesión terminó', commandId);
      metrics.inc(res.duplicate ? 'commands_duplicate' : 'commands_accepted');
      logger.info('command_accepted', { sessionId: conn.sessionId, commandId, stateVersion: res.state.stateVersion, effect: res.duplicate ? undefined : res.state.payload.effect, duplicate: res.duplicate });
      // `ack` = el servidor ACEPTÓ y publicó la orden. NO significa que los dispositivos ya la aplicaron (eso lo informa `stats`).
      send(conn, { protocolVersion: P.PROTOCOL_VERSION, type: 'ack', commandId, stateVersion: res.state.stateVersion, executeAt: res.state.executeAt, serverTimestamp: nowMs(), duplicate: res.duplicate });
    } catch (e) {
      if (e instanceof P.ProtocolError) {
        metrics.inc('commands_rejected');
        return send(conn, P.server.error(e.code, e.message, { commandId: msg.commandId }));      // solo se incluye si es un commandId válido
      }
      metrics.inc('commands_failed');
      logger.error('command_failed', { sessionId: conn.sessionId, error: e.message });
      send(conn, P.server.error('PUBLISH_FAILED', 'No se pudo publicar la orden, reintentá', { commandId: msg.commandId }));
    }
  }

  // ------------------------------------------------------------------ confirmaciones de aplicación (muestreadas)
  const ackBuf = new Map();   // `${sid}|${ver}` -> {sid, ver, delta}
  function handleApplied(conn, a) {
    const room = conn.room;
    const latest = room.latest ? room.latest.stateVersion : 0;
    if (a.stateVersion > latest || a.stateVersion < latest - 5) { metrics.inc('applied_out_of_window'); return; }     // solo versiones recientes
    // La confirmación debe corresponder a ESA orden: un dispositivo no puede contar para la orden de otra versión con un commandId ajeno.
    const known = room.cmdByVersion && room.cmdByVersion.get(a.stateVersion);
    if (known !== undefined && known !== a.commandId) { metrics.inc('applied_mismatch'); return; }
    // Una confirmación por dispositivo y versión: los duplicados no inflan el conteo.
    if (!conn.applied || conn.applied.inc !== room.incarnation) conn.applied = { inc: room.incarnation, v: [] };
    if (conn.applied.v.includes(a.stateVersion)) { metrics.inc('applied_duplicate'); return; }
    conn.applied.v.push(a.stateVersion); if (conn.applied.v.length > 6) conn.applied.v.shift();
    metrics.inc('applied_reports');
    const key = conn.sessionId + '|' + a.stateVersion;
    let e = ackBuf.get(key);
    if (!e) { e = { sid: conn.sessionId, ver: a.stateVersion, delta: {} }; ackBuf.set(key, e); }
    const d = e.delta; const abs = Math.abs(a.deviationMs);
    d.n = (d.n || 0) + 1;
    if (abs <= config.onTimeToleranceMs) d.on = (d.on || 0) + 1; else d.late = (d.late || 0) + 1;
    if (a.receiveLeadMs !== null && a.receiveLeadMs < 0) d.la = (d.la || 0) + 1;
    const b = 'b' + ackBucket(abs); d[b] = (d[b] || 0) + 1;
  }
  async function flushAcks() {
    if (!ackBuf.size) return;
    const items = [...ackBuf.values()]; ackBuf.clear();
    for (const it of items) { try { await store.ackAdd(it.sid, it.ver, it.delta); } catch (e) { metrics.inc('store_errors'); logger.warn('ack_flush_failed', { error: e.message }); } }
  }

  function scheduleStats(room, st) {
    room.statsVersion = st.stateVersion; room.statsTicks = 0;
    if (room.statsTimer) return;
    room.statsTimer = setInterval(async () => {
      if (!room.masters.size || ++room.statsTicks > 20) { clearInterval(room.statsTimer); room.statsTimer = null; return; }
      try {
        const [summary, total] = await Promise.all([store.ackSummary(room.id, room.statsVersion), store.presenceTotal(room.id)]);
        room.globalTotal = total;
        const out = { protocolVersion: P.PROTOCOL_VERSION, type: 'stats', stateVersion: room.statsVersion, connected: total, ...summary, serverTimestamp: nowMs() };
        for (const m of room.masters) send(m, out);
      } catch (e) { metrics.inc('store_errors'); }
    }, 1000);
    room.statsTimer.unref();
  }

  // ------------------------------------------------------------------ bucles periódicos
  function heartbeatTick() {
    const set = buckets[tick++ % buckets.length];
    for (const conn of set) {
      if (!conn.alive) { metrics.inc('heartbeat_timeouts'); conn.ws.terminate(); continue; }
      conn.alive = false;
      try { conn.ws.ping(); } catch { /* cerrando */ }
    }
  }

  function resyncTick() {
    for (const conn of needResync) {
      if (conn.closed) { needResync.delete(conn); continue; }
      if (conn.ws.bufferedAmount > config.bufferSoftBytes) continue;
      needResync.delete(conn); conn.strikes = 0;
      const st = conn.room && conn.room.latest;
      if (st) { metrics.inc('resyncs'); send(conn, P.server.state(conn.sessionId, st, { resync: true, ackRate: 0 })); }
    }
  }

  async function presenceTick() {
    if (presenceBusy) return;
    presenceBusy = true;
    try {
      const t = nowMs();
      for (const room of rooms.values()) {
        const local = room.publics.size;
        if (local !== room.lastPresenceSet || t - room.lastPresenceSetAt > config.presenceTtlMs / 3) {
          room.lastPresenceSet = local; room.lastPresenceSetAt = t;
          await store.presenceSet(room.id, config.instanceId, local);
        }
        {
          const total = await store.presenceTotal(room.id);
          room.globalTotal = total;           // todas las instancias conocen la audiencia GLOBAL: ackRate = min(1, objetivo / audiencia global)
        }
        if (room.masters.size) {
          const total = room.globalTotal;
          if (total !== room.lastPresenceSent || t - room.lastPresenceSentAt > 5000) {
            room.lastPresenceSent = total; room.lastPresenceSentAt = t;
            const health = getHealth ? getHealth() : null;
            for (const m of room.masters) send(m, { protocolVersion: P.PROTOCOL_VERSION, type: 'presence', connected: total, localConnected: local, health, serverTimestamp: nowMs() });
          }
        }
      }
    } catch (e) { metrics.inc('store_errors'); logger.warn('presence_failed', { error: e.message }); }
    finally { presenceBusy = false; }
  }

  function sampleGauges() {
    let pub = 0; let mas = 0; let buffered = 0;
    for (const r of rooms.values()) {
      pub += r.publics.size; mas += r.masters.size;
      for (const c of r.publics.values()) buffered += c.ws.bufferedAmount;
    }
    metrics.setGauge('connections_public', pub); metrics.setGauge('connections_master', mas);
    metrics.setGauge('rooms', rooms.size); metrics.setGauge('ws_buffered_bytes', buffered); metrics.setGauge('resync_pending', needResync.size);
    metrics.sampleProcess();
  }

  function start() {
    const every = (fn, ms) => { const t = setInterval(fn, ms); t.unref(); timers.push(t); };
    every(heartbeatTick, 1000);
    every(resyncTick, 1000);
    every(presenceTick, config.presenceIntervalMs);
    setTimeout(() => every(reconcileTick, config.reconcileIntervalMs), Math.floor(Math.random() * config.reconcileIntervalMs)).unref();   // desfasado entre instancias
    every(() => { flushAcks(); }, 1000);
    every(sampleGauges, 5000);
  }

  // ------------------------------------------------------------------ apagado ordenado
  async function drain(spreadMs = config.shutdownSpreadMs) {
    draining = true;
    await flushAcks();
    const all = [];
    for (const r of rooms.values()) { for (const m of r.masters) all.push(m); for (const c of r.publics.values()) all.push(c); }
    logger.info('draining', { connections: all.length, spreadMs });
    // Se avisa y se cierra escalonado con código 1012: los clientes reconectan con jitter y no se produce una avalancha.
    const batches = Math.max(1, Math.ceil(spreadMs / 100));
    const per = Math.ceil(all.length / batches);
    await new Promise(resolve => {
      let b = 0;
      const t = setInterval(() => {
        const slice = all.slice(b * per, (b + 1) * per);
        for (const c of slice) {
          send(c, { protocolVersion: P.PROTOCOL_VERSION, type: 'restart', reconnectAfterMs: 500 + Math.floor(Math.random() * 4000), serverTimestamp: nowMs() });
          closeConn(c, CLOSE.RESTART, 'SERVER_RESTART');
        }
        if (++b >= batches || b * per >= all.length) { clearInterval(t); resolve(); }
      }, 100);
    });
  }

  function stop() {
    for (const t of timers) clearInterval(t);
    for (const r of rooms.values()) if (r.statsTimer) clearInterval(r.statsTimer);
  }

  return {
    CLOSE, accept, start, stop, drain, flushAcks,
    get draining() { return draining; },
    get connectionCount() { return connCount; },
    stats() {
      let pub = 0; let mas = 0; const perSession = [];
      for (const r of rooms.values()) { pub += r.publics.size; mas += r.masters.size; perSession.push({ sessionId: r.id, public: r.publics.size, masters: r.masters.size }); }
      return { connections: connCount, public: pub, masters: mas, rooms: rooms.size, resyncPending: needResync.size, perSession };
    },
    roomCount: () => rooms.size,
    ipState: ip => ipConns.get(ip) || { pre: 0, total: 0 },
    // Tamaño de las estructuras internas (para detectar fugas en pruebas y /api/admin/status)
    debugCounts: () => ({ rooms: rooms.size, connections: connCount, heartbeatBuckets: buckets.reduce((n, b) => n + b.size, 0), needResync: needResync.size, ackBuf: ackBuf.size, ipTracked: ipConns.size,
      statsTimers: [...rooms.values()].filter(r => r.statsTimer).length })
  };
}

module.exports = { createHub, CLOSE };
