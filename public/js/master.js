/* Destello·Sync — panel Master. Todo el texto dinámico se muestra con textContent (nunca innerHTML).
 * Autenticación: contraseña de operador -> token firmado (sessionStorage de ESTA pestaña) -> token de Master por sesión (solo en memoria).
 */
(function () {
  'use strict';
  var PROTOCOL = 1;
  var $ = function (id) { return document.getElementById(id); };
  var PALETTE = ['#FFFFFF', '#FFD400', '#FF9F1C', '#FF3B30', '#34C759', '#00C7BE', '#0A84FF', '#5856D6', '#AF52DE', '#FF2D55', '#7C4DFF', '#000000'];
  var S = {
    op: null, session: null, masterToken: null, ws: null, attempts: 0, reconnectTimer: null, closing: false,
    color: '#FFD400', effect: 'solid', strobeEnabled: false, maxHz: 3, tracker: DestelloPending.createTracker(), orders: DestelloOrders.createOrders(), maxStrobeMs: 30000, lastAccepted: null, lastStatsVersion: 0, latestVersion: 0, connected: false
  };
  try { S.op = JSON.parse(sessionStorage.getItem('ds-op') || 'null'); } catch (e) { S.op = null; }
  if (S.op && S.op.expiresAt < Date.now()) S.op = null;

  function newId() {
    var a = new Uint8Array(12); (window.crypto || window.msCrypto).getRandomValues(a);
    return 'm' + Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function pill(id, text, cls) { var n = $(id); n.textContent = text; n.className = 'pill' + (cls ? ' ' + cls : ''); }
  function alertBox(kind, text, key) {
    var box = $('alerts'); var old = key && box.querySelector('[data-key="' + key + '"]');
    if (old) old.remove();
    if (!text) return;
    var d = document.createElement('div'); d.className = 'alert ' + kind; d.textContent = text; if (key) d.setAttribute('data-key', key);
    box.appendChild(d);
  }

  // ---------------------------------------------------------------- REST
  function api(method, path, body) {
    var headers = { 'content-type': 'application/json' };
    if (S.op) headers.authorization = 'Bearer ' + S.op.token;
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && path !== '/api/master/login') { logout(true); throw new Error('Sesión de operador vencida: volvé a ingresar'); }
        if (!r.ok) throw new Error(j.message || j.error || ('Error ' + r.status));
        return j;
      });
    });
  }
  function logout(expired) {
    S.op = null; try { sessionStorage.removeItem('ds-op'); sessionStorage.removeItem('ds-sid'); } catch (e) { /* bloqueado */ }
    teardown(); show('loginView', true); show('setupView', false); show('control', false); show('logout', false); show('logoutAll', false); show('flashCard', false);
    pill('status', '● sin sesión'); $('loginError').textContent = expired ? 'La sesión de operador venció. Ingresá de nuevo.' : '';
  }
  function teardown() {
    S.closing = true; clearTimeout(S.reconnectTimer);
    if (S.ws) { try { S.ws.close(); } catch (e) { /* ya cerrado */ } S.ws = null; }
    S.session = null; S.masterToken = null; S.connected = false;
  }

  // ---------------------------------------------------------------- vistas
  function enter() {
    show('loginView', false); show('logout', true); show('logoutAll', true); flashLoad();
    var sid = null; try { sid = sessionStorage.getItem('ds-sid'); } catch (e) { /* bloqueado */ }
    if (sid) return resume(sid).catch(function () { showSetup(); });
    showSetup();
  }
  function showSetup() {
    teardown(); show('setupView', true); show('control', false); pill('status', '● sin sesión');
    api('GET', '/api/sessions').then(function (j) {
      var ul = $('sessionList'); ul.textContent = '';
      (j.sessions || []).forEach(function (s) {
        var li = document.createElement('li');
        var span = document.createElement('span'); span.textContent = s.id + '  ·  ' + new Date(s.createdAt).toLocaleString();
        var b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.textContent = 'Retomar';
        b.addEventListener('click', function () { resume(s.id).catch(function (e) { alertBox('bad', e.message, 'setup'); }); });
        li.appendChild(span); li.appendChild(b); ul.appendChild(li);
      });
      if (!(j.sessions || []).length) { var li = document.createElement('li'); li.textContent = 'No hay sesiones activas.'; li.style.fontFamily = 'inherit'; ul.appendChild(li); }
    }).catch(function () { /* logout ya mostrado */ });
  }
  function adopt(d) {
    S.closing = false;
    S.session = d.sessionId; S.masterToken = d.masterToken; S.strobeEnabled = !!d.strobeEnabled;
    try { sessionStorage.setItem('ds-sid', d.sessionId); } catch (e) { /* bloqueado */ }
    $('code').textContent = d.sessionId; $('url').textContent = d.joinUrl;
    var qr = $('qr'); qr.textContent = '';
    new QRCode(qr, { text: d.joinUrl, width: 420, height: 420, colorDark: '#111', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
    show('setupView', false); show('control', true); alertBox('', null, 'setup');
    paintStrobe(); connect();
  }
  function create() { return api('POST', '/api/sessions', {}).then(adopt); }
  function resume(id) { return api('POST', '/api/sessions/' + id + '/master-token', {}).then(adopt); }

  // ---------------------------------------------------------------- app Flash (acceso habilitable por el operador)
  // El interruptor vive en el servidor (/api/admin/flash). El código del QR Flash es solo una etiqueta para los teléfonos (la app Flash no usa el servidor).
  var FLASH_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var F = { enabled: false, url: '', code: null, loaded: false };
  function flashNewCode() {
    var a = new Uint8Array(6); (window.crypto || window.msCrypto).getRandomValues(a);
    var c = ''; for (var i = 0; i < 6; i++) c += FLASH_CHARS[a[i] % FLASH_CHARS.length];     // sesgo mínimo: irrelevante para una etiqueta pública
    F.code = c; try { sessionStorage.setItem('ds-flash-code', c); } catch (e) { /* bloqueado */ }
  }
  function flashLink() { return F.url + '?s=' + F.code; }
  function flashPaint() {
    show('flashCard', true);
    pill('flashState', F.enabled ? 'Flash: HABILITADA' : 'Flash: deshabilitada', F.enabled ? 'ok' : '');
    $('flashToggle').textContent = F.enabled ? 'Deshabilitar app Flash' : 'Habilitar app Flash';
    $('flashToggle').disabled = false;
    show('flashOn', F.enabled);
    if (!F.enabled) { $('flashQr').textContent = ''; return; }
    if (!F.code) { try { F.code = sessionStorage.getItem('ds-flash-code'); } catch (e) { F.code = null; } if (!/^[A-HJ-NP-Z2-9]{6}$/.test(F.code || '')) flashNewCode(); }
    var link = flashLink();
    $('flashCode').textContent = F.code; $('flashUrl').textContent = link;
    var qr = $('flashQr'); qr.textContent = '';
    new QRCode(qr, { text: link, width: 230, height: 230, colorDark: '#111', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
  }
  function flashApply(j) { F.enabled = !!j.enabled; F.url = j.url; F.loaded = true; flashPaint(); }
  function flashLoad() {
    return api('GET', '/api/admin/flash').then(flashApply).catch(function (e) {
      pill('flashState', 'Flash: sin datos', 'bad'); show('flashCard', true); alertBox('bad', 'No se pudo consultar el estado de la app Flash: ' + e.message, 'flash');
    });
  }
  function flashToggle() {
    $('flashToggle').disabled = true;
    return api('POST', '/api/admin/flash', { enabled: !F.enabled }).then(function (j) { alertBox('', null, 'flash'); flashApply(j); })
      .catch(function (e) { $('flashToggle').disabled = false; alertBox('bad', 'No se pudo cambiar la app Flash: ' + e.message, 'flash'); });
  }

  // ---------------------------------------------------------------- WebSocket del Master
  function wsUrl() { return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws'; }
  function connect() {
    if (S.closing || !S.session) return;
    if (S.ws) { try { S.ws.onclose = null; S.ws.close(); } catch (e) { /* ya cerrado */ } }
    pill('status', '● conectando', ''); $('hConn').textContent = 'conectando…';
    var ws = new WebSocket(wsUrl()); S.ws = ws;
    ws.onopen = function () { ws.send(JSON.stringify({ protocolVersion: PROTOCOL, type: 'hello', role: 'master', sessionId: S.session, token: S.masterToken })); };
    ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMessage(m); };
    ws.onclose = function (ev) {
      if (S.ws === ws) S.ws = null; S.connected = false; $('send').disabled = true;
      S.tracker.onDisconnect();
      if (S.closing) return;
      pill('status', '● sin conexión', 'bad'); $('hConn').textContent = 'sin conexión (' + ev.code + ')';
      if (ev.code === 4401) return resume(S.session).catch(function (e) { alertBox('bad', e.message, 'conn'); });          // token vencido o revocado: pedir uno nuevo
      if (ev.code === 4404) return recreate();                                                                              // la sesión se perdió (p. ej. reinicio sin Redis)
      reconnect(ev.code === 1012 ? 500 + Math.random() * 3000 : null);
    };
  }
  function recreate() {
    alertBox('warn', 'La sesión se perdió en el servidor (¿reinicio?). Recreándola con el mismo código para que los teléfonos la retomen…', 'conn');
    api('POST', '/api/sessions', { sessionId: S.session }).then(function (d) { adopt(d); alertBox('info', 'Sesión recuperada con el mismo código.', 'conn'); })
      .catch(function (e) { alertBox('bad', 'No se pudo recrear la sesión: ' + e.message, 'conn'); });
  }
  function reconnect(hint) {
    if (S.reconnectTimer) return;
    S.attempts++; var cap = Math.min(15000, 500 * Math.pow(2, Math.min(S.attempts, 5)));
    var d = hint == null ? Math.max(300, Math.random() * cap) : hint;
    S.reconnectTimer = setTimeout(function () { S.reconnectTimer = null; connect(); }, d);
  }
  function send(obj) { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(obj)); return true; } return false; }

  function onMessage(m) {
    switch (m.type) {
      case 'welcome':
        S.attempts = 0; S.connected = true; pill('status', '● online', 'ok'); $('hConn').textContent = 'conectado'; $('send').disabled = false;
        S.strobeEnabled = !!m.config.strobeEnabled; S.maxHz = m.config.maxStrobeHz || 3; S.maxStrobeMs = m.config.maxStrobeDurationMs || 30000; paintDurationLimit(); $('maxHz').textContent = String(S.maxHz); $('hz').max = String(S.maxHz);
        $('count').textContent = String(m.connected || 0); showState(m.state); paintStrobe();
        S.latestVersion = m.state ? m.state.stateVersion : 0;
        resendAfterReconnect();
        break;
      case 'presence':
        $('count').textContent = String(m.connected); $('countDetail').textContent = 'En esta instancia: ' + m.localConnected;
        if (m.health) paintHealth(m.health);
        break;
      case 'ack': onAck(m); break;
      case 'state': if (m.stateVersion > S.latestVersion) S.latestVersion = m.stateVersion; S.orders.state(m); showState(m); break;
      case 'stats': onStats(m); break;
      case 'config': S.strobeEnabled = !!m.strobeEnabled; paintStrobe(); break;
      case 'error': onServerError(m); break;
      case 'restart': reconnect(Math.max(500, Math.min(8000, m.reconnectAfterMs || 2000))); break;
      default: break;
    }
  }
  // Un ACK solo confirma el comando con ESE commandId. Duplicados, desconocidos y tardíos se clasifican y no alteran la orden actual:
  // cada respuesta actualiza el registro de SU orden (S.orders) y la interfaz muestra únicamente la orden más reciente.
  function onAck(m) {
    var r = S.tracker.ack(m);
    var rec = S.orders.accepted(m);                      // también corrige una orden ya declarada «sin confirmación» si su ACK llega tarde
    if (r.kind === 'duplicate' || r.kind === 'unknown') { renderOrder(); return; }
    if (r.kind === 'late') { alertBox('info', 'Llegó la confirmación tardía de una orden anterior (v' + m.stateVersion + '); la orden actual sigue su curso.', 'ack'); setTimeout(function () { alertBox('info', null, 'ack'); }, 4000); renderOrder(); return; }
    alertBox('warn', null, 'cmd');
    S.lastAccepted = m;
    renderOrder();
  }
  // El servidor respondió `error`. Con commandId válido se cierra SOLO esa orden (rechazada, con código y explicación). Sin commandId no se asocia
  // a ninguna orden: se avisa al operador y las órdenes pendientes terminan por tiempo (reintentos / tiempo máximo), nunca quedan abiertas.
  function onServerError(m) {
    var id = typeof m.commandId === 'string' ? m.commandId : null;
    S.tracker.reject(id);
    var rec = id ? S.orders.rejected(id, m.code, m.message) : null;
    S.unassociatedErrors = (S.unassociatedErrors || 0) + (rec ? 0 : 1);
    alertBox('bad', m.code + ': ' + DestelloOrders.explain(m.code, m.message) + (id ? '' : ' (no corresponde a una orden concreta)'), 'cmd');
    setTimeout(function () { alertBox('bad', null, 'cmd'); }, 8000);
    renderOrder();
  }
  function onStats(m) {
    var rec = S.orders.applied(m);                       // por stateVersion -> solo la orden vinculada a esa versión
    if (m.connected != null) $('count').textContent = String(m.connected);
    if (rec && rec === S.orders.current()) paintLateWarning(m);
    renderOrder();
  }
  function resendAfterReconnect() {
    var r = S.tracker.onReconnect();
    r.dropped.forEach(function (e) {
      if (!e.superseded) S.orders.failed(e.id, 'offline');
      alertBox('warn', 'Se descartó una orden que no llegó a confirmarse antes de la desconexión (ya era antigua o fue reemplazada por otra más nueva).', 'drop'); setTimeout(function () { alertBox('warn', null, 'drop'); }, 6000);
    });
    r.resend.forEach(function (e) { send(e.msg); S.orders.retry(e.id, e.attempts); });
    renderOrder();
  }
  // Vencimiento de ACK: se reenvía el MISMO commandId (el servidor es idempotente) y, agotados los intentos (o el tiempo sin conexión), la orden
  // se declara SIN CONFIRMACIÓN en el indicador principal. S.orders.tick() aplica además el tope absoluto y el plazo de confirmación de dispositivos.
  setInterval(function () {
    var d = S.tracker.due();
    d.resend.forEach(function (e) { if (S.connected) { send(e.msg); S.orders.retry(e.id, e.attempts); } else e.attempts--; });
    d.failed.forEach(function (e) {
      S.orders.retry(e.id, e.attempts); S.orders.failed(e.id, e.failReason || 'retries');
      alertBox('bad', 'El servidor no confirmó la orden (' + (e.failReason === 'offline' ? 'sin conexión' : e.attempts + ' intentos') + '). Verificá la conexión y volvé a enviarla.', 'cmd');
    });
    S.orders.tick();
    renderOrder();
  }, 500);

  // ---------------------------------------------------------------- indicadores de la última orden (derivados del registro real de S.orders)
  var LEVEL_CLASS = { ok: 'st-ok', bad: 'st-bad', warn: 'st-warn', pending: 'st-pending', muted: 'st-muted' };
  function setStatus(id, d) { var n = $(id); n.textContent = d.text; n.className = LEVEL_CLASS[d.level] || ''; }
  var EFFECT_LABEL = { solid: 'Fijo', fade: 'Transición', pulse: 'Pulso', strobe: 'Strobe', sequence: 'Secuencia', off: 'Detener' };
  function renderOrder() {
    var cur = S.orders.current();
    if (!cur) { setStatus('kAccepted', { text: '—', level: 'muted' }); setStatus('kApplied', { text: '—', level: 'muted' }); return; }
    setStatus('kAccepted', S.orders.describeServer(cur));
    setStatus('kApplied', S.orders.describeDevices(cur));
    var st = cur.dev.stats;
    if (st && st.responded) {
      $('kOnTime').textContent = st.onTimePct + '% dentro de ±' + st.toleranceMs + ' ms · ' + st.late + ' fuera de margen';
      $('kDev').textContent = 'p50 ' + st.deviationP50Ms + ' ms · p95 ' + st.deviationP95Ms + ' ms · p99 ' + st.deviationP99Ms + ' ms';
    } else { $('kOnTime').textContent = '—'; $('kDev').textContent = '—'; }
    var ul = $('orderLog'); ul.textContent = '';
    S.orders.recent(6).forEach(function (r) {
      var li = document.createElement('li');
      var a = document.createElement('span'); a.textContent = new Date(r.createdAt).toLocaleTimeString() + '  ' + (EFFECT_LABEL[r.effect] || r.effect);
      var b = document.createElement('span'); var sv = S.orders.describeServer(r), dv = S.orders.describeDevices(r);
      b.textContent = sv.text.split(' · ')[0].split(' (')[0].split(':')[0] + (r.dev.phase === 'idle' || r.dev.phase === 'none' ? '' : ' → ' + dv.text.split(':')[0].split(' (')[0]);
      b.className = LEVEL_CLASS[sv.level] || '';
      li.appendChild(a); li.appendChild(b); ul.appendChild(li);
    });
  }
  function paintLateWarning(m) {
    var lateArrivalPct = m.responded ? (m.lateArrival * 100 / m.responded) : 0;
    if (m.responded >= 20 && (m.onTimePct < 90 || lateArrivalPct > 5)) {
      alertBox('warn', 'Las órdenes podrían estar llegando tarde (' + m.onTimePct + '% a tiempo, ' + Math.round(lateArrivalPct) + '% llegaron después de su ejecución). Elegí un margen mayor.', 'late');
    } else alertBox('warn', null, 'late');
  }

  function showState(st) {
    if (!st || !st.payload) return;
    $('kState').textContent = 'v' + st.stateVersion + ' · ' + st.payload.effect + (st.payload.effect === 'off' ? '' : ' · ' + st.payload.color);
  }
  function paintHealth(h) {
    var cls = h.status === 'ok' ? 'ok' : (h.status === 'degraded' ? '' : 'bad');
    pill('health', 'salud: ' + h.status, cls);
    $('hStatus').textContent = h.status + (h.reasons && h.reasons.length ? ' — ' + h.reasons.join('; ') : '');
    $('hLag').textContent = h.eventLoopLagP99Ms + ' ms (p99)';
    var ck = h.clockRtt; $('hClock').textContent = ck && ck.n ? 'RTT p50 ' + Math.round(ck.p50) + ' ms · p95 ' + Math.round(ck.p95) + ' ms → error de sincronía ≤ ' + Math.round(ck.p50 / 2) + ' / ' + Math.round(ck.p95 / 2) + ' ms (n=' + ck.n + ')' : '—';
    $('hStore').textContent = h.storeLatencyMs == null ? 'sin respuesta' : Math.round(h.storeLatencyMs * 10) / 10 + ' ms';
    if (h.status !== 'ok') alertBox(h.status === 'degraded' ? 'warn' : 'bad', 'Sistema ' + h.status + ': las órdenes podrían llegar tarde. ' + (h.reasons || []).join('; '), 'health');
    else alertBox('', null, 'health');
  }
  function paintStrobe() {
    show('strobeBox', S.effect === 'strobe' || S.strobeEnabled || (S.effect === 'sequence' && seqMinHoldMs() < 1000));
    $('strobeState').textContent = S.strobeEnabled ? 'Strobe HABILITADO en esta sesión (máx ' + S.maxHz + ' Hz, duración limitada).' : 'Strobe deshabilitado (valor seguro por defecto).';
    show('strobeEnable', !S.strobeEnabled); show('strobeDisable', S.strobeEnabled);
  }

  // ---------------------------------------------------------------- controles
  // Los límites del panel deben coincidir con los del servidor (protocolo v1): periodo 600–10000 ms, transición 0–10000 ms, pulso hasta 600 s y strobe
  // hasta maxStrobeDurationMs (30 s por defecto; llega en el welcome). Un valor fuera de rango se AJUSTA y se avisa, en vez de enviarse para ser rechazado.
  function durationMaxS() { return S.effect === 'strobe' ? Math.max(1, Math.floor(S.maxStrobeMs / 1000)) : 600; }
  function paintDurationLimit() {
    var el = $('durationS'); el.max = String(durationMaxS());
    // En Pulso 0 significa «sin límite»; el strobe SIEMPRE tiene duración (mín. 0,5 s): al pasar a Strobe un 0 heredado de Pulso se cambia por 10 s (valor por defecto).
    if (S.effect === 'strobe' && !(Number(el.value) > 0)) el.value = '10';
    if (Number(el.value) > durationMaxS()) el.value = String(durationMaxS());
  }
  // ---------------------------------------------------------------- Secuencia de colores (lista editable: color + segundos; botón «＋» para agregar)
  var SEQ_MIN = 2, SEQ_MAX = 12;
  S.steps = [{ color: '#FFD400', sec: 3 }, { color: '#0A84FF', sec: 3 }]; S.seqSel = 0;
  function seqMinHoldMs() { return Math.min.apply(null, S.steps.map(function (s) { return Math.round((Number(s.sec) || 0) * 1000); })); }
  function seqSummary() {
    var total = S.steps.reduce(function (a, s) { return a + (Number(s.sec) || 0); }, 0);
    var txt = S.steps.length + ' colores · ciclo de ' + (Math.round(total * 10) / 10) + ' s · se repite hasta DETENER TODO';
    if (seqMinHoldMs() < 1000) txt += ' · ⚠ un paso dura menos de 1 s: se considera intermitente y exige habilitar el strobe';
    $('seqSummary').textContent = txt; paintStrobe();
  }
  function renderSeq() {
    var ol = $('seqList'); ol.textContent = '';
    S.steps.forEach(function (st, i) {
      var li = document.createElement('li'); li.className = 'seq-row' + (i === S.seqSel ? ' sel' : '');
      li.addEventListener('click', function () { S.seqSel = i; Array.prototype.forEach.call(ol.children, function (c, k) { c.classList.toggle('sel', k === i); }); });
      var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = i === 0 ? 'Color inicial' : 'Color ' + (i + 1);
      var c = document.createElement('input'); c.type = 'color'; c.value = st.color.toLowerCase(); c.setAttribute('aria-label', nm.textContent);
      c.addEventListener('input', function () { st.color = c.value.toUpperCase(); });
      var sec = document.createElement('input'); sec.type = 'number'; sec.min = '0.5'; sec.max = '600'; sec.step = '0.5'; sec.value = String(st.sec); sec.setAttribute('aria-label', 'Segundos del ' + nm.textContent.toLowerCase());
      sec.addEventListener('input', function () { st.sec = Number(sec.value); seqSummary(); });
      var unit = document.createElement('span'); unit.className = 'muted small'; unit.textContent = 's';
      var del = document.createElement('button'); del.type = 'button'; del.className = 'btn del'; del.textContent = '✕'; del.title = 'Quitar este color'; del.setAttribute('aria-label', 'Quitar ' + nm.textContent.toLowerCase());
      del.disabled = S.steps.length <= SEQ_MIN;
      del.addEventListener('click', function (ev) { ev.stopPropagation(); if (S.steps.length <= SEQ_MIN) return; S.steps.splice(i, 1); S.seqSel = Math.min(S.seqSel, S.steps.length - 1); renderSeq(); });
      li.appendChild(nm); li.appendChild(c); li.appendChild(sec); li.appendChild(unit); li.appendChild(del); ol.appendChild(li);
    });
    $('seqAdd').disabled = S.steps.length >= SEQ_MAX;
    seqSummary();
  }
  $('seqAdd').addEventListener('click', function () {
    if (S.steps.length >= SEQ_MAX) return;
    var last = S.steps[S.steps.length - 1];
    S.steps.push({ color: PALETTE[(S.steps.length * 3) % PALETTE.length], sec: last ? last.sec : 3 }); S.seqSel = S.steps.length - 1; renderSeq();
  });

  function setEffect(e) {
    S.effect = e;
    show('pSeq', e === 'sequence');
    document.querySelectorAll('[data-effect]').forEach(function (b) { b.classList.toggle('primary', b.getAttribute('data-effect') === e); });
    show('pFade', e === 'solid' || e === 'fade'); show('pColor2', e === 'fade' || e === 'pulse' || e === 'strobe');
    show('pPeriod', e === 'pulse'); show('pHz', e === 'strobe'); show('pDur', e === 'pulse' || e === 'strobe'); paintStrobe(); paintDurationLimit();
  }
  function selectColor(c, btn) {
    if (S.effect === 'sequence') { S.steps[S.seqSel].color = c; renderSeq(); return; }       // en Secuencia la paleta asigna el color de la fila marcada
    S.color = c; $('custom').value = c.toLowerCase(); $('colorHex').textContent = c;
    document.querySelectorAll('.color').forEach(function (x) { x.classList.toggle('active', x === btn); });
  }
  PALETTE.forEach(function (c) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'color'; b.style.background = c; b.title = c; b.setAttribute('aria-label', c);
    b.addEventListener('click', function () { selectColor(c, b); }); $('colors').appendChild(b); if (c === S.color) b.classList.add('active');
  });
  $('custom').addEventListener('input', function (e) { var c = e.target.value.toUpperCase(); if (S.effect === 'sequence') { S.steps[S.seqSel].color = c; renderSeq(); return; } S.color = c; $('colorHex').textContent = c; document.querySelectorAll('.color').forEach(function (x) { x.classList.remove('active'); }); });
  document.querySelectorAll('[data-effect]').forEach(function (b) { b.addEventListener('click', function () { setEffect(b.getAttribute('data-effect')); }); });
  renderSeq();
  setEffect('solid');

  function sendCommand() {
    var notes = [];
    function lim(val, min, max, name, unit) {
      var v = Number(val); if (!isFinite(v)) v = min;
      var c = Math.min(max, Math.max(min, v)); if (c !== v) notes.push(name + ' ajustado a ' + c + unit + ' (límite permitido ' + min + '–' + max + unit + ')');
      return c;
    }
    var p = { effect: S.effect, color: S.color };
    if (S.effect === 'solid' || S.effect === 'fade') p.fadeMs = Math.round(lim($('fadeMs').value, 0, 10000, 'Duración de transición', ' ms'));
    if (S.effect === 'fade' || S.effect === 'pulse' || S.effect === 'strobe') p.color2 = $('color2').value.toUpperCase();
    if (S.effect === 'pulse') { p.periodMs = Math.round(lim($('periodMs').value, 600, 10000, 'Período', ' ms')); p.durationMs = Math.round(lim($('durationS').value, 0, 600, 'Duración', ' s') * 1000); }
    if (S.effect === 'strobe') { p.hz = lim(Number($('hz').value) || 2, 0.5, S.maxHz, 'Frecuencia', ' Hz'); p.durationMs = Math.round(lim(Number($('durationS').value) || 10, 0.5, S.maxStrobeMs / 1000, 'Duración', ' s') * 1000); }
    if (S.effect === 'sequence') {
      var steps = S.steps.map(function (st, i) { return { color: st.color.toUpperCase(), holdMs: Math.round(lim(st.sec, 0.5, 600, 'Segundos del color ' + (i + 1), ' s') * 1000) }; });
      var minHold = Math.min.apply(null, steps.map(function (st) { return st.holdMs; }));
      p = { effect: 'sequence', steps: steps, fadeMs: Math.round(lim($('seqFadeMs').value, 0, Math.min(10000, minHold), 'Transición', ' ms')), durationMs: Math.round(lim($('seqDurationS').value, 0, 600, 'Duración', ' s') * 1000) };
    }
    var msg = { protocolVersion: PROTOCOL, type: 'command', commandId: newId(), leadMs: Number($('lead').value) || 1500, payload: p };
    if (notes.length) { alertBox('info', notes.join(' · '), 'adjust'); setTimeout(function () { alertBox('info', null, 'adjust'); }, 6000); }
    track(msg, 'command');
  }
  // Registra el comando (el anterior queda "superado") y lo envía; si no hay conexión queda en cola y se reenvía al reconectar si sigue siendo reciente.
  function track(msg, kind) {
    var online = Boolean(S.ws && S.ws.readyState === 1);
    S.tracker.add(msg, { kind: kind, sent: online });
    S.orders.create({ id: msg.commandId, kind: kind, effect: msg.payload ? msg.payload.effect : 'off' });
    if (!online) alertBox('bad', 'Sin conexión con el servidor: la orden se enviará al reconectar (si no pasan más de 15 s).', 'cmd');
    else send(msg);
    renderOrder();
    return online;
  }
  function emergencyStop() {
    var ok = track({ protocolVersion: PROTOCOL, type: 'stop', commandId: newId() }, 'stop');
    if (!ok) alertBox('bad', 'SIN CONEXIÓN: no se pudo enviar la parada. Se reintentará al reconectar.', 'cmd');
  }

  $('send').addEventListener('click', sendCommand);
  $('stop').addEventListener('click', emergencyStop);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.session) emergencyStop(); });
  $('riskAck').addEventListener('change', function () { $('strobeEnable').disabled = !$('riskAck').checked; });
  $('strobeEnable').addEventListener('click', function () { send({ protocolVersion: PROTOCOL, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: $('riskAck').checked }); });
  $('strobeDisable').addEventListener('click', function () { send({ protocolVersion: PROTOCOL, type: 'setConfig', strobeEnabled: false }); $('riskAck').checked = false; $('strobeEnable').disabled = true; });
  $('create').addEventListener('click', function () { create().catch(function (e) { alertBox('bad', e.message, 'setup'); }); });
  $('refresh').addEventListener('click', showSetup);
  $('copy').addEventListener('click', function () { if (navigator.clipboard) navigator.clipboard.writeText($('url').textContent); });
  $('open').addEventListener('click', function () { window.open($('url').textContent, '_blank', 'noopener'); });
  // «Salir» revoca el token EN EL SERVIDOR (no basta con olvidarlo en el navegador): si alguien lo hubiera copiado, deja de valer. Es un mejor esfuerzo: si la petición
  // falla (sin red) igualmente se cierra la sesión local, y el token vence solo.
  function serverLogout(all) {
    var tok = S.op && S.op.token; if (!tok) return Promise.resolve();
    return fetch('/api/master/logout', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify({ all: all }), cache: 'no-store' }).catch(function () { /* sin red */ });
  }
  $('logout').addEventListener('click', function () { serverLogout(false); logout(false); });
  $('logoutAll').addEventListener('click', function () {
    if (!window.confirm('¿Cerrar la sesión de operador en TODOS los dispositivos y navegadores? Tendrás que volver a ingresar con la contraseña.')) return;
    serverLogout(true); logout(false);
  });
  $('flashToggle').addEventListener('click', flashToggle);
  $('flashNewCode').addEventListener('click', function () { flashNewCode(); flashPaint(); });
  $('flashCopy').addEventListener('click', function () { if (navigator.clipboard) navigator.clipboard.writeText($('flashUrl').textContent); });
  $('flashOpen').addEventListener('click', function () { window.open($('flashUrl').textContent, '_blank', 'noopener'); });
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault(); $('loginError').textContent = '';
    api('POST', '/api/master/login', { password: $('password').value }).then(function (j) {
      S.op = { token: j.operatorToken, expiresAt: j.expiresAt }; $('password').value = '';
      try { sessionStorage.setItem('ds-op', JSON.stringify(S.op)); } catch (e2) { /* bloqueado */ }
      enter();
    }).catch(function (err) { $('loginError').textContent = err.message; });
  });
  // Mientras hay sesión, el estado de salud también se consulta periódicamente por si el WebSocket está caído.
  setInterval(function () {
    if (!S.op || S.connected || !S.session) return;
    api('GET', '/api/admin/status').then(function (j) { paintHealth(j.health); }).catch(function () { /* ignorado */ });
  }, 10000);

  // Gancho para pruebas de navegador (solo lectura del estado interno).
  window.DestelloMaster = { tracker: S.tracker, orders: S.orders, state: S };

  if (S.op) enter();
})();
