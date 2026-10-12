'use strict';
// UNIDAD: ciclo de vida de las órdenes del panel (public/js/orders.js) junto con el rastreador de reintentos (public/js/pending.js).
// Módulos puros con reloj simulado; lo que NO cubren (red, servidor, navegador) se prueba en test/ordenes-servidor.test.js y e2e/ordenes.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrders, explain } = require('../public/js/orders');
const { createTracker } = require('../public/js/pending');

function clock(t0 = 1_000_000) { let t = t0; return { now: () => t, advance: ms => { t += ms; } }; }
const id = n => 'cmd-' + String(n).padStart(8, '0');
const msg = n => ({ protocolVersion: 1, type: 'command', commandId: id(n), payload: { effect: 'solid', color: '#FFFFFF' } });
const ack = (n, v, c, extra = {}) => ({ commandId: id(n), stateVersion: v, executeAt: c.now() + 1500, serverTimestamp: c.now(), duplicate: false, ...extra });
const stats = (v, o = {}) => ({ stateVersion: v, connected: 4, responded: 0, onTimePct: 100, toleranceMs: 100, ...o });

// Réplica del cableado de master.js: tracker (reintentos) + orders (estado visible).
function panel(c, opts = {}) {
  const tracker = createTracker({ now: c.now, ...opts.tracker });
  const orders = createOrders({ now: c.now, ...opts.orders });
  const api = {
    tracker, orders,
    send(n) { const m = msg(n); tracker.add(m, { kind: 'command', sent: true }); return orders.create({ id: m.commandId, effect: 'solid' }); },
    tick() {
      const d = tracker.due();
      d.resend.forEach(e => orders.retry(e.id, e.attempts));
      d.failed.forEach(e => { orders.retry(e.id, e.attempts); orders.failed(e.id, e.failReason || 'retries'); });
      orders.tick();
    },
    onAck(a) { tracker.ack(a); return orders.accepted(a); },
    onError(code, cid, message) { tracker.reject(cid); return orders.rejected(cid, code, message); }
  };
  return api;
}

test('envío -> ACK: SERVIDOR aceptada (con versión y margen); DISPOSITIVOS queda «esperando» (aceptar no es aplicar)', () => {
  const c = clock(); const p = panel(c);
  const o = p.send(1);
  assert.equal(p.orders.describeServer(o).text, 'ENVIANDO…'); assert.equal(p.orders.describeServer(o).level, 'pending');
  p.onAck(ack(1, 1, c));
  assert.match(p.orders.describeServer(o).text, /^ACEPTADA POR EL SERVIDOR · v1 · ejecuta en 1500 ms$/);
  assert.equal(o.dev.phase, 'waiting');
  assert.match(p.orders.describeDevices(o).text, /esperando confirmaciones/);
  assert.ok(!/APLICADA/.test(p.orders.describeDevices(o).text), 'no se marca aplicada solo porque el servidor la aceptó');
});

test('error del servidor con commandId: cierra ESA orden con código y explicación; no queda pendiente ni se reintenta', () => {
  const c = clock(); const p = panel(c);
  const o = p.send(1);
  p.onError('STROBE_DISABLED', id(1), 'x');
  assert.equal(o.server.phase, 'rejected'); assert.equal(p.tracker.size(), 0);
  const d = p.orders.describeServer(o);
  assert.equal(d.level, 'bad'); assert.match(d.text, /^RECHAZADA: STROBE_DISABLED — el strobe está deshabilitado/);
  assert.equal(p.orders.isFinal(o), true);
  c.advance(60000); p.tick(); assert.equal(o.server.phase, 'rejected', 'el tiempo no cambia un rechazo');
  assert.match(p.orders.describeDevices(o).text, /no aplica/);
});

test('error SIN commandId: no se asocia a ninguna orden (no se inventa); la orden termina por tiempo', () => {
  const c = clock(); const p = panel(c);
  const o = p.send(1);
  assert.equal(p.onError('INVALID_JSON', undefined, 'JSON inválido'), null);
  assert.equal(o.server.phase, 'sending', 'sigue esperando: no se le atribuyó un error ajeno');
  assert.equal(p.orders.stats.unknownResponses, 1);
  for (let i = 0; i < 4; i++) { c.advance(3001); p.tick(); }
  assert.equal(o.server.phase, 'failed'); assert.equal(p.orders.isFinal(o), true);
});

test('reintentos agotados: el indicador principal pasa a SIN CONFIRMACIÓN (el mismo commandId se reenvió 3 veces)', () => {
  const c = clock(); const p = panel(c);
  const o = p.send(1);
  c.advance(3001); p.tick(); assert.equal(p.orders.describeServer(o).text, 'ENVIANDO… (reintento 1)');
  c.advance(3001); p.tick(); assert.equal(p.orders.describeServer(o).text, 'ENVIANDO… (reintento 2)');
  c.advance(3001); p.tick();
  assert.equal(o.server.phase, 'failed'); assert.equal(o.server.reason, 'retries');
  assert.match(p.orders.describeServer(o).text, /^SIN CONFIRMACIÓN: el servidor no respondió tras 3 intentos/);
  assert.equal(p.orders.describeServer(o).level, 'bad'); assert.equal(p.tracker.size(), 0);
});

test('timeout finito SIN ninguna respuesta aunque el rastreador no intervenga (tope absoluto)', () => {
  const c = clock(); const orders = createOrders({ now: c.now, sendTimeoutMs: 20000 });
  const o = orders.create({ id: id(1), effect: 'pulse' });
  c.advance(19999); orders.tick(); assert.equal(o.server.phase, 'sending');
  c.advance(2); assert.equal(orders.tick(), true);
  assert.equal(o.server.phase, 'failed'); assert.equal(o.server.reason, 'timeout');
  assert.match(orders.describeServer(o).text, /^SIN CONFIRMACIÓN: .*tiempo máximo/);
});

test('sin conexión: la orden en cola no espera para siempre (se declara fallida por «offline»)', () => {
  const c = clock(); const p = panel(c, { tracker: { maxResendAgeMs: 15000 } });
  const o = p.send(1); p.tracker.onDisconnect();
  c.advance(10000); p.tick(); assert.equal(o.server.phase, 'sending', 'aún dentro del plazo de reconexión');
  c.advance(5001); p.tick();
  assert.equal(o.server.phase, 'failed'); assert.equal(o.server.reason, 'offline'); assert.equal(p.tracker.size(), 0);
  assert.match(p.orders.describeServer(o).text, /sin conexión con el servidor durante demasiado tiempo/);
});

test('respuesta TARDÍA tras el timeout: corrige SU orden (el servidor sí la aceptó) y no toca la orden más reciente', () => {
  const c = clock(); const p = panel(c);
  const a = p.send(1);
  for (let i = 0; i < 3; i++) { c.advance(3001); p.tick(); }
  assert.equal(a.server.phase, 'failed');
  const b = p.send(2); p.onAck(ack(2, 2, c));
  const before = JSON.stringify(p.orders.describeServer(p.orders.current()));
  p.onAck(ack(1, 1, c));                                              // llega tarde el ACK de A
  assert.equal(a.server.phase, 'accepted'); assert.equal(a.server.late, true);
  assert.match(p.orders.describeServer(a).text, /confirmación tardía/);
  assert.equal(p.orders.current(), b);
  assert.equal(JSON.stringify(p.orders.describeServer(p.orders.current())), before, 'el indicador principal (orden B) no cambió');
});

test('dos órdenes consecutivas: la primera queda REEMPLAZADA; ACK, error y stats de una no se confunden con los de la otra', () => {
  const c = clock(); const p = panel(c);
  const a = p.send(1); const b = p.send(2);
  assert.equal(a.server.phase, 'superseded'); assert.equal(p.orders.current(), b);
  assert.match(p.orders.describeServer(a).text, /^REEMPLAZADA/);
  p.onAck(ack(1, 1, c));                                              // ACK de A: no limpia a B
  assert.equal(b.server.phase, 'sending'); assert.equal(a.server.phase, 'superseded');
  assert.equal(p.orders.describeServer(p.orders.current()).text, 'ENVIANDO…');
  p.onAck(ack(2, 2, c));
  p.orders.state({ commandId: id(2), stateVersion: 2, ackRate: 1 });
  p.orders.applied(stats(1, { responded: 4 }));                       // stats de la versión de A
  assert.equal(b.dev.responded, 0, 'las confirmaciones de la versión 1 no cuentan para la orden B');
  p.orders.applied(stats(2, { responded: 4 }));
  assert.equal(b.dev.phase, 'applied');
  p.onError('OUT_OF_RANGE', id(1), 'x');                              // error tardío de A (ya superada)
  assert.equal(b.server.phase, 'accepted', 'un error de A no rechaza a B');
});

test('un error NO deshace una orden ya aceptada y un ACK NO revierte un rechazo (se cuentan como conflictos)', () => {
  const c = clock(); const p = panel(c);
  const a = p.send(1); p.onAck(ack(1, 1, c)); p.onError('PUBLISH_FAILED', id(1));
  assert.equal(a.server.phase, 'accepted');
  c.advance(10); const b = p.send(2); p.onError('RATE_LIMITED', id(2)); p.onAck(ack(2, 2, c));
  assert.equal(b.server.phase, 'rejected'); assert.equal(p.orders.stats.conflicts, 2);
});

test('DISPOSITIVOS: confirmaciones parciales, completas, ausentes y sin dispositivos (plazo finito)', () => {
  const run = (statsMsg, connected, advance) => {
    const c = clock(); const p = panel(c, { orders: { applyGraceMs: 6000 } });
    const o = p.send(1); p.onAck(ack(1, 1, c)); p.orders.state({ commandId: id(1), stateVersion: 1, ackRate: 1 });
    if (statsMsg) p.orders.applied(stats(1, { connected, ...statsMsg }));
    c.advance(advance); p.orders.tick(); return { o, d: p.orders.describeDevices(o) };
  };
  // todos confirman: aplicada y terminal sin esperar el plazo
  let r = run({ responded: 4 }, 4, 0); assert.equal(r.o.dev.phase, 'applied'); assert.equal(r.o.dev.final, true); assert.match(r.d.text, /^APLICADA: 4 dispositivos confirmaron \(muestra de ~4\)/);
  // 2 de 4 (50 % < 80 %): parcial; al vencer el plazo queda así (terminal)
  r = run({ responded: 2 }, 4, 0); assert.equal(r.o.dev.phase, 'partial'); assert.equal(r.o.dev.final, false);
  r = run({ responded: 2 }, 4, 8000);   // plazo = instante de ejecución (1,5 s) + 6 s assert.equal(r.o.dev.phase, 'partial'); assert.equal(r.o.dev.final, true); assert.match(r.d.text, /^APLICADA PARCIALMENTE: 2 de ~4/);
  // 4 de 5 (80 %): se considera aplicada
  r = run({ responded: 4 }, 5, 0); assert.equal(r.o.dev.phase, 'applied');
  // ninguno informa: espera y, al vencer el plazo, SIN CONFIRMACIÓN (no se da por aplicada)
  r = run({ responded: 0 }, 4, 3000); assert.equal(r.o.dev.phase, 'waiting');
  r = run({ responded: 0 }, 4, 8000); assert.equal(r.o.dev.phase, 'none'); assert.match(r.d.text, /SIN CONFIRMACIÓN DE DISPOSITIVOS.*NO demostrada/); assert.ok(!/^APLICADA/.test(r.d.text));
  // ni siquiera llegó un stats
  r = run(null, 0, 8000); assert.equal(r.o.dev.phase, 'none');
  // sin dispositivos conectados
  r = run({ responded: 0 }, 0, 8000); assert.equal(r.o.dev.phase, 'nobody'); assert.match(r.d.text, /SIN DISPOSITIVOS CONECTADOS/);
});

test('stats duplicados son idempotentes y stats de una versión desconocida no alteran nada', () => {
  const c = clock(); const p = panel(c);
  const o = p.send(1); p.onAck(ack(1, 1, c)); p.orders.state({ commandId: id(1), stateVersion: 1, ackRate: 1 });
  p.orders.applied(stats(1, { responded: 3 })); p.orders.applied(stats(1, { responded: 3 })); p.orders.applied(stats(1, { responded: 3 }));
  assert.equal(o.dev.responded, 3);
  assert.equal(p.orders.applied(stats(99, { responded: 4 })), null);
  assert.equal(o.dev.responded, 3);
});

test('historial acotado y órdenes recientes en orden (la más nueva primero)', () => {
  const c = clock(); const orders = createOrders({ now: c.now, historyLimit: 5 });
  for (let i = 1; i <= 12; i++) { orders.create({ id: id(i), effect: 'solid' }); c.advance(1); }
  assert.equal(orders.size(), 5); assert.equal(orders.current().id, id(12)); assert.equal(orders.recent(3)[2].id, id(10));
  assert.equal(orders.get(id(1)), null, 'las muy antiguas se olvidan (memoria acotada)');
});

test('explicaciones comprensibles de los códigos de error del protocolo', () => {
  for (const code of ['RATE_LIMITED', 'STROBE_DISABLED', 'OUT_OF_RANGE', 'INVALID_COLOR', 'PUBLISH_FAILED', 'SESSION_NOT_FOUND', 'UNAUTHORIZED', 'RISK_NOT_ACKNOWLEDGED']) assert.ok(explain(code).length > 20, code);
  assert.equal(explain('OTRO_CODIGO', 'mensaje del servidor'), 'mensaje del servidor', 'código desconocido: se muestra el mensaje del servidor');
  assert.match(explain('OTRO_CODIGO'), /rechazó/);
});
