/* Destello·Sync — seguimiento de comandos pendientes del Master (módulo puro, sin DOM ni red).
 *
 * POLÍTICA (documentada en docs/PROTOCOLO.md):
 *  - Se pueden tener varios comandos en vuelo; CADA UNO se rastrea por su `commandId`. Un ACK solo confirma el comando cuyo
 *    identificador coincide; nunca "limpia" a otro.
 *  - "El último gana": al crear un comando nuevo, los pendientes anteriores quedan `superseded`. El protocolo es de ESTADO: reenviar
 *    una orden vieja después de una nueva podría revertirla, así que los superados NO se reintentan ni se reenvían al reconectar
 *    (se siguen recordando hasta recibir su ACK, para clasificarlo bien: es un ACK "tardío", válido pero sin efecto sobre la orden actual).
 *  - Reintento: si no hay ACK en `ackTimeoutMs`, se reenvía el MISMO commandId (el servidor es idempotente) hasta `maxAttempts` veces;
 *    después la orden se declara fallida y se informa al operador.
 *  - Desconexión: los comandos enviados pasan a `queued`; al reconectar solo se reenvía el más reciente no superado y únicamente si
 *    no es más viejo que `maxResendAgeMs` (una intención vieja no se reaplica a ciegas).
 *  - ACK duplicado, desconocido o tardío: se clasifican y se ignoran; nunca corrompen el estado.
 *  - Un ACK confirma que el servidor ACEPTÓ y publicó la orden. NO demuestra que ninguna pantalla la haya aplicado.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DestelloPending = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createTracker(opts) {
    opts = opts || {};
    var ackTimeoutMs = opts.ackTimeoutMs || 3000;
    var stopTimeoutMs = opts.stopTimeoutMs || 1500;
    var maxAttempts = opts.maxAttempts || 3;
    var maxResendAgeMs = opts.maxResendAgeMs || 15000;
    var recentLimit = opts.recentLimit || 64;
    var now = opts.now || function () { return Date.now(); };

    var pending = new Map();            // commandId -> entry
    var recentAcked = [];               // commandIds confirmados recientemente (para clasificar duplicados)
    var seq = 0;
    var stats = { added: 0, ackedOk: 0, ackedLate: 0, ackedDuplicate: 0, ackedUnknown: 0, retries: 0, failed: 0, superseded: 0, rejected: 0, staleDropped: 0 };

    function remember(id) { recentAcked.push(id); if (recentAcked.length > recentLimit) recentAcked.shift(); }

    return {
      stats: stats,
      /** Registra un comando recién enviado (o por enviar). Los anteriores pendientes quedan superados. */
      add: function (msg, o) {
        o = o || {};
        var t = now();
        pending.forEach(function (e) { if (!e.superseded) { e.superseded = true; stats.superseded++; } });
        var e = { id: msg.commandId, msg: msg, kind: o.kind || 'command', createdAt: t, lastSentAt: o.sent === false ? 0 : t, attempts: o.sent === false ? 0 : 1,
          state: o.sent === false ? 'queued' : 'sent', superseded: false, order: ++seq, timeoutMs: (o.kind === 'stop' ? stopTimeoutMs : ackTimeoutMs) };
        pending.set(e.id, e); stats.added++;
        return e;
      },
      /** Procesa un ACK del servidor. Devuelve {kind: 'ok'|'late'|'duplicate'|'unknown', entry}. */
      ack: function (ack) {
        var id = ack && ack.commandId;
        var e = id ? pending.get(id) : null;
        if (e) {
          pending.delete(id); remember(id);
          if (e.superseded) { stats.ackedLate++; return { kind: 'late', entry: e }; }
          stats.ackedOk++; return { kind: 'ok', entry: e };
        }
        if (id && recentAcked.indexOf(id) >= 0) { stats.ackedDuplicate++; return { kind: 'duplicate', entry: null }; }
        stats.ackedUnknown++; return { kind: 'unknown', entry: null };
      },
      /** El servidor rechazó la orden (error con commandId): no se reintenta. */
      reject: function (commandId) {
        var e = commandId ? pending.get(commandId) : null;
        if (!e) return null;
        pending.delete(commandId); stats.rejected++; return e;
      },
      /** Comandos cuyo ACK venció y deben reenviarse ahora (mismo commandId). Los que agotaron los intentos se devuelven en `failed`. */
      due: function () {
        var t = now(); var resend = []; var failed = [];
        pending.forEach(function (e) {
          if (e.state !== 'sent' || t - e.lastSentAt < e.timeoutMs) return;
          if (e.superseded) { pending.delete(e.id); stats.staleDropped++; return; }                 // ya no importa: hay uno más nuevo
          if (e.attempts >= maxAttempts) { pending.delete(e.id); stats.failed++; failed.push(e); return; }
          e.attempts++; e.lastSentAt = t; stats.retries++; resend.push(e);
        });
        resend.sort(function (a, b) { return a.order - b.order; });
        return { resend: resend, failed: failed };
      },
      /** La conexión se cayó: lo enviado pasa a la cola (se decidirá qué reenviar al reconectar). */
      onDisconnect: function () { pending.forEach(function (e) { if (e.state === 'sent') e.state = 'queued'; }); },
      /** Al reconectar: devuelve a lo sumo UN comando (el más reciente no superado y no vencido) para reenviar; descarta los viejos. */
      onReconnect: function () {
        var t = now(); var out = []; var dropped = [];
        pending.forEach(function (e) {
          if (e.superseded) { pending.delete(e.id); stats.staleDropped++; dropped.push(e); return; }
          if (t - e.createdAt > maxResendAgeMs) { pending.delete(e.id); stats.staleDropped++; dropped.push(e); return; }
          out.push(e);
        });
        out.sort(function (a, b) { return a.order - b.order; });
        var latest = out.length ? [out[out.length - 1]] : [];
        out.slice(0, -1).forEach(function (e) { pending.delete(e.id); stats.staleDropped++; dropped.push(e); });
        latest.forEach(function (e) { e.state = 'sent'; e.attempts++; e.lastSentAt = t; });
        return { resend: latest, dropped: dropped };
      },
      has: function (id) { return pending.has(id); },
      get: function (id) { return pending.get(id) || null; },
      size: function () { return pending.size; },
      /** El comando más reciente no superado (el único que "importa" para la interfaz). */
      current: function () { var best = null; pending.forEach(function (e) { if (!e.superseded && (!best || e.order > best.order)) best = e; }); return best; },
      ids: function () { return Array.from(pending.keys()); }
    };
  }

  return { createTracker: createTracker };
});
