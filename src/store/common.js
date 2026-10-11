'use strict';
// Piezas compartidas por los stores (memoria y Redis).
const ACK_EDGES = [10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000]; // ms, desviación absoluta; +1 bucket final (>1000)

function initialState(now = Date.now()) {
  return {
    // `incarnation` identifica la vida de la sesión (su instante de creación): si una sesión se pierde y se re-crea con el mismo código,
    // las versiones vuelven a empezar y los clientes/hubs deben saberlo para no descartar las órdenes nuevas como "viejas".
    commandId: 'init', stateVersion: 0, serverTimestamp: now, executeAt: 0, incarnation: now,
    payload: { effect: 'off', color: '#000000', color2: '#000000', intensity: 1 }
  };
}

function ackBucket(absDeviationMs) {
  let i = 0;
  while (i < ACK_EDGES.length && absDeviationMs > ACK_EDGES[i]) i++;
  return i;
}

// Estadísticas agregadas a partir de contadores sumados entre instancias.
function summarizeAcks(h, tolerance) {
  const n = Number(h.n || 0);
  if (!n) return { responded: 0 };
  const buckets = ACK_EDGES.map((_, i) => Number(h['b' + i] || 0)).concat([Number(h['b' + ACK_EDGES.length] || 0)]);
  const q = p => {
    const target = Math.ceil(n * p); let acc = 0;
    for (let i = 0; i < buckets.length; i++) { acc += buckets[i]; if (acc >= target) return i < ACK_EDGES.length ? ACK_EDGES[i] : '>' + ACK_EDGES[ACK_EDGES.length - 1]; }
    return null;
  };
  return {
    responded: n, onTime: Number(h.on || 0), late: Number(h.late || 0), lateArrival: Number(h.la || 0),
    onTimePct: Math.round((Number(h.on || 0) / n) * 1000) / 10, toleranceMs: tolerance,
    deviationP50Ms: q(0.5), deviationP95Ms: q(0.95), deviationP99Ms: q(0.99)
  };
}

module.exports = { ACK_EDGES, initialState, ackBucket, summarizeAcks };
