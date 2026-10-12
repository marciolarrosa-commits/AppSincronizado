'use strict';
// Rastreador de comandos pendientes del Master (módulo puro): política de ACK, reintentos, duplicados y reconexión.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracker } = require('../public/js/pending');

function clock() { let t = 1_000_000; return { now: () => t, advance: ms => { t += ms; } }; }
const msg = id => ({ protocolVersion: 1, type: 'command', commandId: id, payload: { effect: 'solid', color: '#FF0000' } });

test('1) envío de A y recepción de su ACK: se confirma y no queda nada pendiente', () => {
  const c = clock(); const t = createTracker({ now: c.now });
  t.add(msg('cmd-A-0000001'));
  const r = t.ack({ commandId: 'cmd-A-0000001', stateVersion: 1 });
  assert.equal(r.kind, 'ok'); assert.equal(t.size(), 0); assert.equal(t.stats.ackedOk, 1);
});

test('2) A y luego B: el ACK tardío de A NO confirma a B (B sigue pendiente y es la orden actual)', () => {
  const c = clock(); const t = createTracker({ now: c.now });
  t.add(msg('cmd-A-0000001')); c.advance(100); t.add(msg('cmd-B-0000001'));
  const late = t.ack({ commandId: 'cmd-A-0000001', stateVersion: 1 });
  assert.equal(late.kind, 'late', 'el ACK de A se clasifica como tardío');
  assert.equal(t.has('cmd-B-0000001'), true, 'B sigue pendiente');
  assert.equal(t.current().id, 'cmd-B-0000001');
  assert.equal(t.ack({ commandId: 'cmd-B-0000001', stateVersion: 2 }).kind, 'ok');
  assert.equal(t.size(), 0);
});

test('2b) el ACK de B antes que el de A: B se confirma, A (superada) queda y su ACK llega como tardío', () => {
  const t = createTracker({ now: clock().now });
  t.add(msg('cmd-A-0000001')); t.add(msg('cmd-B-0000001'));
  assert.equal(t.ack({ commandId: 'cmd-B-0000001' }).kind, 'ok');
  assert.equal(t.has('cmd-A-0000001'), true);
  assert.equal(t.ack({ commandId: 'cmd-A-0000001' }).kind, 'late');
});

test('3) ACK duplicado: se ignora y no altera nada', () => {
  const t = createTracker({ now: clock().now });
  t.add(msg('cmd-A-0000001')); t.add(msg('cmd-B-0000001'));
  assert.equal(t.ack({ commandId: 'cmd-B-0000001' }).kind, 'ok');
  const dup = t.ack({ commandId: 'cmd-B-0000001' });
  assert.equal(dup.kind, 'duplicate'); assert.equal(t.stats.ackedDuplicate, 1);
  assert.equal(t.has('cmd-A-0000001'), true, 'un duplicado de B no toca a A');
});

test('4) ACK de un identificador desconocido (o sin commandId): se ignora sin efectos', () => {
  const t = createTracker({ now: clock().now });
  t.add(msg('cmd-A-0000001'));
  assert.equal(t.ack({ commandId: 'nadie-0000000001' }).kind, 'unknown');
  assert.equal(t.ack({}).kind, 'unknown'); assert.equal(t.ack(null).kind, 'unknown'); assert.equal(t.ack({ commandId: 12345 }).kind, 'unknown');
  assert.equal(t.has('cmd-A-0000001'), true, 'el comando pendiente sigue intacto');
  assert.equal(t.stats.ackedUnknown, 4);
});

test('5) timeout y reintento: se reenvía el MISMO commandId hasta agotar los intentos y luego se declara fallido', () => {
  const c = clock(); const t = createTracker({ now: c.now, ackTimeoutMs: 3000, maxAttempts: 3 });
  const e = t.add(msg('cmd-A-0000001'));
  assert.deepEqual(t.due(), { resend: [], failed: [] }, 'antes del timeout no hay nada que reenviar');
  c.advance(3001); let d = t.due(); assert.equal(d.resend.length, 1); assert.equal(d.resend[0].msg.commandId, 'cmd-A-0000001');
  c.advance(3001); d = t.due(); assert.equal(d.resend.length, 1);
  c.advance(3001); d = t.due(); assert.equal(d.resend.length, 0); assert.equal(d.failed.length, 1, 'tercer intento agotado');
  assert.equal(t.size(), 0); assert.equal(t.stats.retries, 2); assert.equal(t.stats.failed, 1); assert.equal(e.attempts, 3);
});

test('5b) un reintento que recibe su ACK deja de reintentarse', () => {
  const c = clock(); const t = createTracker({ now: c.now });
  t.add(msg('cmd-A-0000001')); c.advance(3001); assert.equal(t.due().resend.length, 1);
  assert.equal(t.ack({ commandId: 'cmd-A-0000001' }).kind, 'ok'); c.advance(10000);
  assert.deepEqual(t.due(), { resend: [], failed: [] });
});

test('5c) un comando superado nunca se reintenta (podría revertir el estado nuevo)', () => {
  const c = clock(); const t = createTracker({ now: c.now });
  t.add(msg('cmd-A-0000001')); c.advance(100); t.add(msg('cmd-B-0000001'));
  c.advance(3001); const d = t.due();
  assert.deepEqual(d.resend.map(e => e.id), ['cmd-B-0000001'], 'solo B se reintenta');
  assert.equal(t.has('cmd-A-0000001'), false, 'A superada se descarta en silencio');
});

test('5d) una parada de emergencia pendiente se reintenta antes (timeout más corto)', () => {
  const c = clock(); const t = createTracker({ now: c.now, ackTimeoutMs: 3000, stopTimeoutMs: 1500 });
  t.add({ type: 'stop', commandId: 'stop-0000000001' }, { kind: 'stop' });
  c.advance(1600); assert.equal(t.due().resend.length, 1);
});

test('6) desconexión con comando pendiente: pasa a la cola, no se reintenta sin conexión y se reenvía al reconectar', () => {
  const c = clock(); const t = createTracker({ now: c.now });
  t.add(msg('cmd-A-0000001'));
  t.onDisconnect(); c.advance(5000);
  assert.deepEqual(t.due(), { resend: [], failed: [] }, 'sin conexión no hay reintentos');
  const r = t.onReconnect();
  assert.deepEqual(r.resend.map(e => e.id), ['cmd-A-0000001'], 'se reenvía con el mismo commandId');
  assert.equal(r.dropped.length, 0);
});

test('6b) tras reconectar solo se reenvía el comando más reciente; los demás se descartan', () => {
  const c = clock(); const t = createTracker({ now: c.now });
  t.add(msg('cmd-A-0000001')); t.add(msg('cmd-B-0000001'), { sent: false }); t.add(msg('cmd-C-0000001'), { sent: false });
  t.onDisconnect();
  const r = t.onReconnect();
  assert.deepEqual(r.resend.map(e => e.id), ['cmd-C-0000001']);
  assert.deepEqual(r.dropped.map(e => e.id).sort(), ['cmd-A-0000001', 'cmd-B-0000001']);
});

test('6c) una orden demasiado vieja no se reaplica a ciegas al reconectar', () => {
  const c = clock(); const t = createTracker({ now: c.now, maxResendAgeMs: 15000 });
  t.add(msg('cmd-A-0000001')); t.onDisconnect(); c.advance(20000);
  const r = t.onReconnect();
  assert.equal(r.resend.length, 0); assert.equal(r.dropped.length, 1); assert.equal(t.stats.staleDropped, 1);
});

test('el rechazo del servidor (error con commandId) cierra solo ese comando', () => {
  const t = createTracker({ now: clock().now });
  t.add(msg('cmd-A-0000001')); t.add(msg('cmd-B-0000001'));
  assert.equal(t.reject('cmd-A-0000001').id, 'cmd-A-0000001');
  assert.equal(t.reject('desconocido-00001'), null); assert.equal(t.reject(undefined), null);
  assert.equal(t.has('cmd-B-0000001'), true);
});

test('la historia de ACK confirmados está acotada (sin crecimiento ilimitado)', () => {
  const t = createTracker({ now: clock().now, recentLimit: 8 });
  for (let i = 0; i < 100; i++) { const id = 'cmd-' + String(i).padStart(10, '0'); t.add(msg(id)); t.ack({ commandId: id }); }
  assert.equal(t.size(), 0);
  assert.equal(t.ack({ commandId: 'cmd-0000000099' }).kind, 'duplicate');
  assert.equal(t.ack({ commandId: 'cmd-0000000001' }).kind, 'unknown', 'lo muy antiguo ya no se recuerda (memoria acotada)');
});
