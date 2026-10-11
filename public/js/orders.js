/* Destello·Sync — ciclo de vida de las órdenes del Master (módulo puro, sin DOM ni red).
 *
 * Cada orden tiene DOS etapas independientes, derivadas de lo que realmente ocurrió (nunca de un texto fijo):
 *
 *   SERVIDOR   sending -> accepted | rejected | failed | superseded
 *     sending     el panel la envió y espera la respuesta (se reintenta con el MISMO commandId, ver pending.js)
 *     accepted    el servidor la validó, la guardó y la publicó (mensaje `ack`). NO significa que alguna pantalla la haya aplicado
 *     rejected    el servidor respondió `error` con el commandId de ESA orden (validación, strobe deshabilitado, límite de frecuencia, almacenamiento...)
 *     failed      sin respuesta: reintentos agotados, sin conexión demasiado tiempo o tiempo máximo total vencido
 *     superseded  se envió otra orden más nueva antes de recibir respuesta: la vieja no se reenvía (podría revertir el estado nuevo)
 *
 *   DISPOSITIVOS  idle -> waiting -> applied | partial | none | nobody       (solo si el servidor la aceptó)
 *     applied     al menos la fracción esperada de la MUESTRA de teléfonos confirmó haberla aplicado (mensaje `stats` del servidor)
 *     partial     confirmó solo una parte de la muestra esperada
 *     none        venció el plazo y ningún teléfono informó (la orden fue aceptada: puede haber llegado, pero NO está demostrado)
 *     nobody      venció el plazo y no había dispositivos conectados
 *
 * Toda orden termina: el estado de SERVIDOR tiene un tiempo máximo (sendTimeoutMs) y el de DISPOSITIVOS un plazo (applyGraceMs).
 * Las respuestas se asocian SIEMPRE por commandId (o por stateVersion, que a su vez se vincula a un commandId): una respuesta tardía o de otra orden
 * solo actualiza la suya y nunca el estado mostrado de la orden actual.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DestelloOrders = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Explicaciones comprensibles de los códigos de error del protocolo (el mensaje del servidor se muestra aparte si aporta algo más).
  var ERROR_EXPLAIN = {
    RATE_LIMITED: 'se enviaron demasiadas órdenes por segundo; esperá un instante y volvé a enviarla',
    STROBE_DISABLED: 'el strobe está deshabilitado en esta sesión; habilitalo con la advertencia de fotosensibilidad y volvé a enviar',
    RISK_NOT_ACKNOWLEDGED: 'para habilitar el strobe hay que confirmar la advertencia de fotosensibilidad',
    OUT_OF_RANGE: 'un valor está fuera del rango permitido (duración, frecuencia o período)',
    INVALID_FIELD: 'un campo de la orden tiene un formato inválido',
    INVALID_COLOR: 'el color debe tener el formato #RRGGBB',
    INVALID_EFFECT: 'efecto desconocido',
    UNKNOWN_FIELD: 'la orden incluye un campo que el servidor no admite',
    UNSUPPORTED_VERSION: 'la versión del protocolo del panel no coincide con la del servidor; recargá la página',
    PUBLISH_FAILED: 'el servidor no pudo publicarla (almacenamiento no disponible); no se aplicó, reintentá',
    SESSION_NOT_FOUND: 'la sesión terminó o venció',
    UNAUTHORIZED: 'el token del panel venció o fue revocado; volvé a ingresar',
    FORBIDDEN: 'no tenés permiso para enviar órdenes',
    INTERNAL: 'error interno del servidor'
  };
  function explain(code, message) {
    var e = ERROR_EXPLAIN[code];
    if (e) return e;
    return message || 'el servidor rechazó la orden';
  }

  var FAIL_TEXT = {
    retries: function (r) { return 'el servidor no respondió tras ' + (r.attempt || '?') + ' intentos; verificá la conexión'; },
    offline: function () { return 'sin conexión con el servidor durante demasiado tiempo; la orden se descartó'; },
    timeout: function () { return 'el servidor no respondió dentro del tiempo máximo'; }
  };

  function createOrders(opts) {
    opts = opts || {};
    var now = opts.now || function () { return Date.now(); };
    var sendTimeoutMs = opts.sendTimeoutMs || 20000;     // tope absoluto de la etapa SERVIDOR (por encima de reintentos y de la cola sin conexión)
    var applyGraceMs = opts.applyGraceMs || 6000;        // plazo, desde el instante de ejecución, para que los teléfonos confirmen
    var historyLimit = opts.historyLimit || 30;
    var appliedFraction = opts.appliedFraction || 0.8;   // fracción de la muestra esperada a partir de la cual se considera «aplicada»

    var records = [];                 // más antiguo -> más nuevo
    var byId = new Map();
    var byVersion = new Map();        // stateVersion -> record (se vincula con ack/state: ambos llevan commandId)
    var seq = 0;
    var stats = { created: 0, accepted: 0, rejected: 0, failed: 0, superseded: 0, lateAccepted: 0, conflicts: 0, unknownResponses: 0 };

    function trim() {
      while (records.length > historyLimit) {
        var old = records.shift(); byId.delete(old.id);
        if (old.server.stateVersion != null && byVersion.get(old.server.stateVersion) === old) byVersion.delete(old.server.stateVersion);
      }
    }
    function link(rec, version) {
      if (version == null) return;
      rec.server.stateVersion = version; byVersion.set(version, rec);
    }

    function create(o) {
      var t = now();
      // Las órdenes anteriores que siguen esperando respuesta quedan reemplazadas: el panel no las reenvía (política «el último gana»).
      records.forEach(function (r) { if (r.server.phase === 'sending') { r.server.phase = 'superseded'; r.server.at = t; stats.superseded++; if (r.dev.phase === 'idle') r.dev.phase = 'none'; } });
      var rec = {
        id: o.id, kind: o.kind || 'command', effect: o.effect || '', label: o.label || '', seq: ++seq, createdAt: t,
        server: { phase: 'sending', attempt: 1, at: t, code: null, message: null, reason: null, late: false, duplicate: false, stateVersion: null, executeAt: null, executeInMs: null },
        dev: { phase: 'idle', responded: 0, expected: null, connected: null, onTimePct: null, deadline: null, final: false, stats: null },
        ackRate: null
      };
      records.push(rec); byId.set(rec.id, rec); stats.created++; trim();
      return rec;
    }

    function retry(id, attempt) { var r = byId.get(id); if (r && r.server.phase === 'sending') r.server.attempt = attempt; return r || null; }

    /** `ack` del servidor: aceptó y publicó la orden. Una confirmación tardía de una orden ya declarada fallida la corrige (es la verdad). */
    function accepted(ack) {
      var r = ack && ack.commandId ? byId.get(ack.commandId) : null;
      if (!r) { stats.unknownResponses++; return null; }
      var ph = r.server.phase;
      if (ph === 'rejected') { stats.conflicts++; return r; }          // contradicción: se conserva el rechazo y se cuenta
      if (ph === 'accepted') return r;                                   // duplicado
      var t = now();
      if (ph === 'failed') { r.server.late = true; stats.lateAccepted++; }
      if (ph === 'sending' || ph === 'failed') { r.server.phase = 'accepted'; stats.accepted++; }
      // ph === 'superseded': se conserva «reemplazada» (el servidor sí la procesó, pero ya no es la orden vigente); igual se guardan sus datos
      r.server.at = t; r.server.duplicate = !!ack.duplicate;
      r.server.executeAt = typeof ack.executeAt === 'number' ? ack.executeAt : null;
      r.server.executeInMs = (typeof ack.executeAt === 'number' && typeof ack.serverTimestamp === 'number') ? Math.max(0, Math.round(ack.executeAt - ack.serverTimestamp)) : null;
      link(r, ack.stateVersion);
      if (r.server.phase === 'accepted' && r.dev.phase === 'idle') {
        r.dev.phase = 'waiting';
        r.dev.deadline = (typeof ack.executeAt === 'number' ? Math.max(t, ack.executeAt) : t) + applyGraceMs;
      }
      return r;
    }

    /** `error` del servidor con commandId: cierra SOLO esa orden. Sin commandId no se asocia a ninguna (el llamador debe registrar el error). */
    function rejected(id, code, message) {
      var r = id ? byId.get(id) : null;
      if (!r) { stats.unknownResponses++; return null; }
      if (r.server.phase === 'accepted') { stats.conflicts++; return r; }
      if (r.server.phase === 'rejected') return r;
      r.server.phase = 'rejected'; r.server.code = code || 'ERROR'; r.server.message = message || null; r.server.at = now();
      r.dev.phase = 'none'; r.dev.final = true; stats.rejected++;
      return r;
    }

    /** Sin respuesta: reintentos agotados ('retries'), sin conexión ('offline') o tiempo máximo ('timeout'). */
    function failed(id, reason) {
      var r = id ? byId.get(id) : null;
      if (!r || r.server.phase !== 'sending') return null;
      r.server.phase = 'failed'; r.server.reason = reason || 'timeout'; r.server.at = now();
      r.dev.phase = 'none'; r.dev.final = true; stats.failed++;
      return r;
    }

    /** Mensaje `state` recibido por el panel (lo difunde a los Master): vincula versión <-> orden y trae la tasa de muestreo de confirmaciones. */
    function state(m) {
      var r = m && m.commandId ? byId.get(m.commandId) : null;
      if (!r) return null;
      if (typeof m.ackRate === 'number') r.ackRate = m.ackRate;
      link(r, m.stateVersion);
      return r;
    }

    function evaluate(r, deadlinePassed) {
      var d = r.dev;
      if (r.server.phase !== 'accepted') return;
      var responded = d.responded || 0, expected = d.expected;
      if (responded > 0) {
        var frac = expected ? responded / expected : 1;
        d.phase = frac >= appliedFraction ? 'applied' : 'partial';
        if (expected && responded >= expected) d.final = true;
      } else if (deadlinePassed) {
        d.phase = (d.connected === 0) ? 'nobody' : 'none';
      }
      if (deadlinePassed) d.final = true;
    }

    /** `stats` del servidor: confirmaciones de dispositivos de UNA versión. Solo actualiza la orden vinculada a esa versión. */
    function stats_(m) {
      var r = m && m.stateVersion != null ? byVersion.get(m.stateVersion) : null;
      if (!r) { stats.unknownResponses++; return null; }
      var d = r.dev;
      d.stats = m; d.responded = m.responded || 0; d.connected = typeof m.connected === 'number' ? m.connected : d.connected; d.onTimePct = m.onTimePct == null ? null : m.onTimePct;
      var rate = r.ackRate;
      d.expected = (rate > 0 && d.connected > 0) ? Math.max(1, Math.round(rate * d.connected)) : (d.connected > 0 ? null : 0);
      if (d.phase === 'waiting' || d.phase === 'applied' || d.phase === 'partial') evaluate(r, false);
      return r;
    }

    /** Avanza los plazos (llamar periódicamente). Devuelve true si algún estado cambió. */
    function tick() {
      var t = now(); var changed = false;
      records.forEach(function (r) {
        if (r.server.phase === 'sending' && t - r.createdAt > sendTimeoutMs) { failed(r.id, 'timeout'); changed = true; }
        if (r.dev.phase === 'waiting' || ((r.dev.phase === 'applied' || r.dev.phase === 'partial') && !r.dev.final)) {
          if (r.dev.deadline != null && t >= r.dev.deadline) { var before = r.dev.phase; evaluate(r, true); if (r.dev.phase !== before || r.dev.final) changed = true; }
        }
      });
      return changed;
    }

    // ---------------------------------------------------------------- texto y nivel para la interfaz (derivados del estado real)
    function describeServer(r) {
      var s = r.server;
      switch (s.phase) {
        case 'sending': return { level: 'pending', text: s.attempt > 1 ? 'ENVIANDO… (reintento ' + (s.attempt - 1) + ')' : 'ENVIANDO…' };
        case 'accepted': return { level: 'ok', text: 'ACEPTADA POR EL SERVIDOR · v' + s.stateVersion + (s.duplicate ? ' (ya estaba aplicada: no se repite)' : '') + (s.executeInMs != null ? ' · ejecuta en ' + s.executeInMs + ' ms' : '') + (s.late ? ' · confirmación tardía' : '') };
        case 'rejected': return { level: 'bad', text: 'RECHAZADA: ' + s.code + ' — ' + explain(s.code, s.message) };
        case 'failed': return { level: 'bad', text: 'SIN CONFIRMACIÓN: ' + (FAIL_TEXT[s.reason] || FAIL_TEXT.timeout)(s) };
        case 'superseded': return { level: 'muted', text: 'REEMPLAZADA por una orden más nueva (no se reenvió)' };
        default: return { level: 'pending', text: '…' };
      }
    }
    function describeDevices(r) {
      var d = r.dev;
      switch (d.phase) {
        case 'idle': return { level: 'muted', text: '—' };
        case 'waiting': return { level: 'pending', text: 'esperando confirmaciones de dispositivos…' };
        case 'applied': return { level: 'ok', text: 'APLICADA: ' + d.responded + ' dispositivos confirmaron (muestra' + (d.expected ? ' de ~' + d.expected : '') + ')' };
        case 'partial': return { level: 'warn', text: 'APLICADA PARCIALMENTE: ' + d.responded + ' de ~' + d.expected + ' dispositivos confirmaron (muestra)' };
        case 'none': return r.server.phase === 'accepted'
          ? { level: 'warn', text: 'SIN CONFIRMACIÓN DE DISPOSITIVOS: ninguno informó haberla aplicado (aceptada por el servidor, aplicación NO demostrada)' }
          : { level: 'muted', text: '— (no aplica: la orden no fue aceptada)' };
        case 'nobody': return { level: 'warn', text: 'SIN DISPOSITIVOS CONECTADOS: no había a quién aplicarla' };
        default: return { level: 'muted', text: '—' };
      }
    }
    /** ¿La orden ya no puede cambiar de estado salvo por una respuesta tardía? */
    function isFinal(r) {
      var sp = r.server.phase;
      if (sp === 'sending') return false;
      if (sp === 'accepted') return !!r.dev.final;
      return true;
    }

    return {
      stats: stats,
      create: create, retry: retry, accepted: accepted, rejected: rejected, failed: failed, state: state, applied: stats_, tick: tick,
      get: function (id) { return byId.get(id) || null; },
      byVersion: function (v) { return byVersion.get(v) || null; },
      /** La orden más reciente: es la ÚNICA que gobierna los indicadores principales. */
      current: function () { return records.length ? records[records.length - 1] : null; },
      recent: function (n) { return records.slice(-(n || 8)).reverse(); },
      size: function () { return records.length; },
      describeServer: describeServer, describeDevices: describeDevices, isFinal: isFinal
    };
  }

  return { createOrders: createOrders, explain: explain, ERROR_EXPLAIN: ERROR_EXPLAIN };
});
