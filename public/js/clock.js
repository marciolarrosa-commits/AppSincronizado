/* Destello·Sync — estimación del reloj del servidor en el teléfono (módulo puro, sin DOM ni red; se prueba en Node).
 *
 * Todos los efectos se calculan como f(tiempo de SERVIDOR − executeAt). Por eso un teléfono que escanea el QR a cualquier hora cae en la fase correcta de la
 * secuencia: lo único que debe conocer bien es «qué hora es en el servidor». Se estima en el teléfono con su reloj monotónico `performance.now()` (la hora
 * de pared del teléfono NO se usa: puede estar mal puesta sin consecuencias).
 *
 *   offset = tiempoServidor − performance.now()        serverNow() = performance.now() + offset
 *
 * Fuentes, de menos a más precisas:
 *   1. «welcome» sin compensar:  offset = serverTimestamp − recvAt            error ≈ demora de BAJADA (decenas/cientos de ms)   [versión anterior]
 *   2. «welcome» + hello:        offset = serverTimestamp + RTT(hello→welcome)/2 − recvAt    error ≈ (subida − bajada)/2 + proceso/2      [3.4.0]
 *   3. ping/pong (estilo NTP):   se queda con la muestra de MENOR RTT de las últimas 12                                                [igual]
 * Límite físico: con subida y bajada asimétricas el error es (subida − bajada)/2; no se puede medir desde el teléfono (solo se acota: ≤ RTT/2).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DestelloClock = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX_RTT_MS = 5000;           // un viaje de ida y vuelta mayor no sirve para estimar el reloj
  var MAX_SAMPLES = 12;
  var RESYNC_JUMP_MS = 1000;       // si la estimación nueva difiere más que esto de la previa, el reloj del servidor cambió (reinicio/otra instancia): se adopta la nueva

  /**
   * Estimación al recibir «welcome».
   * @param o {serverTimestamp, recvAt, helloAt, prevOffset, prevSynced}  (todo en ms; recvAt/helloAt con performance.now())
   * @returns {offset, source: 'hello'|'welcome'|'previa'}
   */
  function fromWelcome(o) {
    var hr = (o.helloAt != null) ? o.recvAt - o.helloAt : null;
    var viaHello = (hr != null && hr >= 0 && hr < MAX_RTT_MS);
    var est = viaHello ? o.serverTimestamp + hr / 2 - o.recvAt : o.serverTimestamp - o.recvAt;
    // Reconexión: la estimación previa (mejor muestreada, de menor RTT) se conserva si es coherente con la nueva.
    if (o.prevSynced && o.prevOffset != null && isFinite(o.prevOffset) && Math.abs(est - o.prevOffset) < RESYNC_JUMP_MS) return { offset: o.prevOffset, source: 'previa' };
    return { offset: est, source: viaHello ? 'hello' : 'welcome' };
  }

  /**
   * Incorpora un pong. `samples` se modifica (máx. 12). Devuelve null si la muestra no es válida, o {rtt, offset, best} con la mejor muestra (menor RTT).
   * @param samples arreglo de {rtt, offset, at}
   * @param msg     pong del servidor {t0, serverTimestamp}
   * @param t1      performance.now() al recibirlo
   */
  function addPong(samples, msg, t1) {
    var rtt = t1 - msg.t0;
    if (!(rtt >= 0) || rtt > MAX_RTT_MS || typeof msg.serverTimestamp !== 'number') return null;
    var offset = msg.serverTimestamp + rtt / 2 - t1;
    samples.push({ rtt: rtt, offset: offset, at: t1 });
    if (samples.length > MAX_SAMPLES) samples.shift();
    var best = samples.reduce(function (a, b) { return b.rtt < a.rtt ? b : a; });
    return { rtt: rtt, offset: offset, best: best };
  }

  return { fromWelcome: fromWelcome, addPong: addPong, MAX_RTT_MS: MAX_RTT_MS, MAX_SAMPLES: MAX_SAMPLES, RESYNC_JUMP_MS: RESYNC_JUMP_MS };
});
