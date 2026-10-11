'use strict';
// EFECTO «SECUENCIA DE COLORES» (V3.3.0): lista de 2–12 colores, cada uno con sus segundos; al llegar al último vuelve al primero, sin fin hasta DETENER TODO.
//  - Unidad: motor de efectos del teléfono (public/js/effects.js) y validación del protocolo (src/protocol.js).
//  - Integración: servidor + WebSocket reales (aceptación, publicación al teléfono, reglas de seguridad visual, errores con commandId).
const test = require('node:test');
const assert = require('node:assert/strict');
const FX = require('../public/js/effects');
const P = require('../src/protocol');
const { startServer, login, createSession, joinPublic, joinMaster, Client, dev } = require('./helpers');

const LIMITS = { maxLeadMs: 8000, maxStrobeHz: 3, maxStrobeDurationMs: 30000, maxPulseDurationMs: 600000 };
const R = '#FF0000', G = '#00FF00', B = '#0000FF';
const steps3 = (h = [1000, 2000, 1000]) => [{ color: R, holdMs: h[0] }, { color: G, holdMs: h[1] }, { color: B, holdMs: h[2] }];
const state = extra => ({ executeAt: 1000, payload: { effect: 'sequence', color: R, color2: '#000000', intensity: 1, steps: steps3(), fadeMs: 0, durationMs: 0, ...extra } });
const at = (st, ms, ctx) => FX.evaluate(st, st.executeAt + ms, ctx).rgb.map(Math.round);
const RGB = { R: [255, 0, 0], G: [0, 255, 0], B: [0, 0, 255] };

// ------------------------------------------------------------------------------------------------ unidad: motor del teléfono
test('secuencia: cada color dura SUS segundos, al llegar al último vuelve al primero y se repite sin fin', () => {
  const s = state();                                       // R 1 s · G 2 s · B 1 s  => ciclo de 4 s
  assert.deepEqual(at(s, 0), RGB.R); assert.deepEqual(at(s, 999), RGB.R);
  assert.deepEqual(at(s, 1000), RGB.G); assert.deepEqual(at(s, 2999), RGB.G);
  assert.deepEqual(at(s, 3000), RGB.B); assert.deepEqual(at(s, 3999), RGB.B);
  assert.deepEqual(at(s, 4000), RGB.R, 'vuelve al primero: ininterrumpida'); assert.deepEqual(at(s, 5000), RGB.G);
  for (const k of [10, 1000, 100000]) { assert.deepEqual(at(s, k * 4000 + 500), RGB.R); assert.deepEqual(at(s, k * 4000 + 1500), RGB.G); assert.deepEqual(at(s, k * 4000 + 3500), RGB.B); }   // horas después, sin deriva
  assert.equal(FX.evaluate(s, 1000 + 7777777).animated, true, 'mientras dura, el bucle de dibujo sigue activo');
});

test('secuencia: dos colores (bandera) alternan exactamente cada N segundos', () => {
  const s = state({ steps: [{ color: '#75AADB', holdMs: 3000 }, { color: '#FFFFFF', holdMs: 3000 }] });
  const seen = []; for (let t = 0; t < 12000; t += 500) seen.push(at(s, t).join());
  assert.deepEqual([...new Set(seen.slice(0, 6))], ['117,170,219']); assert.deepEqual([...new Set(seen.slice(6, 12))], ['255,255,255']); assert.deepEqual([...new Set(seen.slice(12, 18))], ['117,170,219']);
});

test('secuencia: transición opcional (fadeMs) al entrar en cada paso; 0 = corte seco; el primer paso parte del color que mostraba el teléfono', () => {
  const s = state({ fadeMs: 400 });
  assert.deepEqual(at(s, 1000), RGB.R, 'al inicio del paso 2 todavía es el color anterior');
  const mid = at(s, 1200); assert.ok(mid[0] > 100 && mid[0] < 160 && mid[1] > 100 && mid[1] < 160, 'a mitad del fundido R→G: ' + mid);
  assert.deepEqual(at(s, 1400), RGB.G); assert.deepEqual(at(s, 2500), RGB.G);
  assert.deepEqual(at(s, 4000), RGB.B, 'al repetir, el primer paso parte del último');
  assert.deepEqual(at(s, 0, { from: [0, 0, 0] }), [0, 0, 0], 'primer arranque: desde el color que se mostraba (negro)');
  assert.deepEqual(at(s, 400, { from: [0, 0, 0] }), RGB.R);
});

test('secuencia: con duración finita se detiene en el color activo y deja de animar; sin duración nunca termina', () => {
  const s = state({ durationMs: 5000 });                  // el instante 5000 cae en el paso G
  assert.deepEqual(at(s, 4900), RGB.R); assert.deepEqual(at(s, 5000), RGB.G); assert.deepEqual(at(s, 99999), RGB.G);
  assert.equal(FX.evaluate(s, 1000 + 99999).animated, false);
  assert.equal(FX.evaluate(state(), 1000 + 99999).animated, true);
});

test('secuencia: «Efectos desactivados» o sin conexión la dejan fija en el primer color; «reducir movimiento» solo la afecta si hay pasos < 1 s (parpadeo)', () => {
  const s = state();
  assert.deepEqual(at(s, 1500, { manualOff: true }), RGB.R); assert.deepEqual(at(s, 3500, { stale: true }), RGB.R);
  assert.deepEqual(at(s, 1500, { systemReduced: true }), RGB.G, 'cambios lentos (≥ 1 s): no son movimiento ni parpadeo');
  const rapid = state({ steps: [{ color: R, holdMs: 500 }, { color: G, holdMs: 500 }] });
  assert.deepEqual(at(rapid, 600, { systemReduced: true }), RGB.R, 'pasos de 0,5 s con «reducir movimiento»: color fijo');
  assert.deepEqual(at(rapid, 600), RGB.G); assert.equal(FX.evaluate(rapid, 1600).flashing, true); assert.equal(FX.evaluate(s, 1600).flashing, false);
});

test('secuencia: el cliente valida lo recibido (2–12 pasos, colores y tiempos válidos) y la ignora si está malformada', () => {
  const ok = state().payload; assert.equal(FX.validPayload(ok), true);
  for (const bad of [{ steps: undefined }, { steps: [steps3()[0]] }, { steps: Array.from({ length: 13 }, () => ({ color: R, holdMs: 1000 })) }, { steps: [{ color: 'rojo', holdMs: 1000 }, { color: G, holdMs: 1000 }] }, { steps: [{ color: R, holdMs: 10 }, { color: G, holdMs: 1000 }] }, { steps: [{ color: R, holdMs: 'x' }, { color: G, holdMs: 1000 }] }])
    assert.equal(FX.validPayload({ ...ok, ...bad }), false, JSON.stringify(bad).slice(0, 60));
});

// ------------------------------------------------------------------------------------------------ unidad: protocolo
const cmd = (payload, id = 'seq-cmd-0001') => ({ type: 'command', commandId: id, payload });
const v = (payload, id) => P.validateCommand(cmd(payload, id), LIMITS);
const code = fn => { try { fn(); return null; } catch (e) { return e.code; } };

test('protocolo: la secuencia válida se normaliza (colores en mayúscula, color = primero, fadeMs y durationMs por defecto 0)', () => {
  const out = v({ effect: 'sequence', steps: [{ color: '#ff0000', holdMs: 3000 }, { color: '#00ff00', holdMs: 3000 }] }).payload;
  assert.deepEqual(out.steps, [{ color: R, holdMs: 3000 }, { color: G, holdMs: 3000 }]);
  assert.equal(out.color, R); assert.equal(out.fadeMs, 0); assert.equal(out.durationMs, 0); assert.equal(out.effect, 'sequence');
  assert.equal(v({ effect: 'sequence', color: 'no-se-usa', steps: steps3() }).payload.color, R, 'el color suelto se ignora: manda steps[0]');
  assert.equal(v({ effect: 'sequence', steps: Array.from({ length: 12 }, (_, i) => ({ color: i % 2 ? G : R, holdMs: 1000 })) }).payload.steps.length, 12);
});

test('protocolo: rechaza secuencias inválidas con el código correcto', () => {
  const S2 = [{ color: R, holdMs: 1000 }, { color: G, holdMs: 1000 }];
  assert.equal(code(() => v({ effect: 'sequence' })), 'INVALID_FIELD');
  assert.equal(code(() => v({ effect: 'sequence', steps: [S2[0]] })), 'INVALID_FIELD', 'mínimo 2 colores');
  assert.equal(code(() => v({ effect: 'sequence', steps: Array.from({ length: 13 }, () => S2[0]) })), 'INVALID_FIELD', 'máximo 12 colores');
  assert.equal(code(() => v({ effect: 'sequence', steps: 'rojo' })), 'INVALID_FIELD');
  assert.equal(code(() => v({ effect: 'sequence', steps: [S2[0], 5] })), 'INVALID_FIELD');
  assert.equal(code(() => v({ effect: 'sequence', steps: [S2[0], { color: G, holdMs: 1000, extra: 1 }] })), 'UNKNOWN_FIELD');
  assert.equal(code(() => v({ effect: 'sequence', steps: [S2[0], { color: 'verde', holdMs: 1000 }] })), 'INVALID_COLOR');
  assert.equal(code(() => v({ effect: 'sequence', steps: [S2[0], { color: G, holdMs: 499 }] })), 'OUT_OF_RANGE', 'paso mínimo 0,5 s');
  assert.equal(code(() => v({ effect: 'sequence', steps: [S2[0], { color: G, holdMs: 600001 }] })), 'OUT_OF_RANGE');
  assert.equal(code(() => v({ effect: 'sequence', steps: [S2[0], { color: G, holdMs: '1000' }] })), 'INVALID_FIELD');
  assert.equal(code(() => v({ effect: 'sequence', steps: S2, fadeMs: 1001 })), 'OUT_OF_RANGE', 'la transición debe caber en el paso más corto');
  assert.equal(code(() => v({ effect: 'sequence', steps: S2, durationMs: 600001 })), 'OUT_OF_RANGE');
  assert.equal(code(() => v({ effect: 'sequence', steps: S2, fadeMs: 1000, durationMs: 0 })), null);
});

// ------------------------------------------------------------------------------------------------ integración: servidor real
const send = (id, payload, extra = {}) => ({ protocolVersion: 1, type: 'command', commandId: id, leadMs: 300, payload, ...extra });
async function setup(t) {
  const srv = await startServer({ wsConnectPerMinPerIp: 1e6, httpPerMin: 1e6 }); t.after(srv.stop);
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phone = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  return { srv, s, master, phone, sid: s.sessionId };
}

test('integración: el servidor acepta la secuencia, la publica íntegra al teléfono y este la evalúa con el motor real (ciclo ininterrumpido)', async t => {
  const { master, phone, srv, sid } = await setup(t);
  master.send(send('seq-int-0001', { effect: 'sequence', steps: [{ color: '#75aadb', holdMs: 3000 }, { color: '#ffffff', holdMs: 3000 }, { color: '#ff0000', holdMs: 1500 }], fadeMs: 500 }));
  const ack = await master.waitFor(m => m.type === 'ack' && m.commandId === 'seq-int-0001');
  const st = await phone.waitFor(m => m.type === 'state' && m.commandId === 'seq-int-0001');
  assert.equal(st.stateVersion, ack.stateVersion); assert.equal(st.payload.effect, 'sequence');
  assert.deepEqual(st.payload.steps, [{ color: '#75AADB', holdMs: 3000 }, { color: '#FFFFFF', holdMs: 3000 }, { color: '#FF0000', holdMs: 1500 }]);
  assert.equal(st.payload.durationMs, 0, 'sin duración: hasta DETENER TODO'); assert.equal(st.payload.fadeMs, 500);
  assert.ok(FX.validPayload(st.payload));
  const col = ms => FX.evaluate({ executeAt: st.executeAt, payload: st.payload }, st.executeAt + ms).rgb.map(Math.round).join();
  assert.equal(col(1000), '117,170,219'); assert.equal(col(4000), '255,255,255'); assert.equal(col(6600), '255,0,0');
  assert.equal(col(7500 + 1000), '117,170,219', 'al terminar el ciclo (7,5 s) vuelve al primero'); assert.equal(col(7500 * 50 + 4000), '255,255,255');
  // un teléfono con la página de V3.0 (sin hello) recibe un estado antiguo válido: color sólido con el primer color
  const old = await new Client(`${srv.wsUrl}?session=${sid}&role=public&deviceId=${dev(7)}`).open(); await old.waitFor('hello');
  master.send(send('seq-int-0002', { effect: 'sequence', steps: [{ color: '#00ff00', holdMs: 2000 }, { color: '#0000ff', holdMs: 2000 }] }));
  const legacy = await old.waitFor('state'); assert.equal(legacy.state.color, '#00FF00'); assert.equal(legacy.state.effect, 'solid');
  // DETENER TODO la apaga
  master.send({ protocolVersion: 1, type: 'stop', commandId: 'seq-stop-0001' });
  const off = await phone.waitFor(m => m.type === 'state' && m.commandId === 'seq-stop-0001'); assert.equal(off.payload.effect, 'off');
});

test('integración: seguridad visual — un paso < 1 s es intermitente y exige habilitar el strobe; nunca supera la frecuencia máxima; los errores llevan commandId', async t => {
  const { master, srv, sid } = await setup(t);
  const fast = [{ color: R, holdMs: 500 }, { color: G, holdMs: 500 }];
  master.send(send('seq-fast-0001', { effect: 'sequence', steps: fast }));
  let e = await master.waitFor('error'); assert.equal(e.code, 'STROBE_DISABLED'); assert.equal(e.commandId, 'seq-fast-0001');
  assert.equal((await srv.app.sessions.get(sid)).state.stateVersion, 0, 'no cambió el estado');
  // con pasos de 1 s o más NO hace falta el strobe
  master.send(send('seq-slow-0001', { effect: 'sequence', steps: [{ color: R, holdMs: 1000 }, { color: G, holdMs: 1000 }] }));
  assert.equal((await master.waitFor(m => m.type === 'ack')).commandId, 'seq-slow-0001');
  // habilitado el strobe (con la advertencia), la de 0,5 s se acepta
  master.send({ protocolVersion: 1, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: true }); await master.waitFor('config');
  master.send(send('seq-fast-0002', { effect: 'sequence', steps: fast }));
  assert.equal((await master.waitFor(m => m.type === 'ack' && m.commandId === 'seq-fast-0002')).duplicate, false);
  // inválidas: error con su commandId y sin tocar el estado
  const v0 = (await srv.app.sessions.get(sid)).state.stateVersion;
  for (const [id, payload, want] of [
    ['seq-bad-0001', { effect: 'sequence', steps: [{ color: R, holdMs: 1000 }] }, 'INVALID_FIELD'],
    ['seq-bad-0002', { effect: 'sequence', steps: [{ color: R, holdMs: 100 }, { color: G, holdMs: 1000 }] }, 'OUT_OF_RANGE'],
    ['seq-bad-0003', { effect: 'sequence', steps: [{ color: 'x', holdMs: 1000 }, { color: G, holdMs: 1000 }] }, 'INVALID_COLOR'],
    ['seq-bad-0004', { effect: 'sequence', steps: [{ color: R, holdMs: 1000 }, { color: G, holdMs: 1000 }], fadeMs: 5000 }, 'OUT_OF_RANGE']
  ]) { master.send(send(id, payload)); const er = await master.waitFor(m => m.type === 'error' && m.commandId === id); assert.equal(er.code, want, id); }
  assert.equal((await srv.app.sessions.get(sid)).state.stateVersion, v0);
});

test('integración: un participante no puede enviar secuencias (solo el Master autenticado)', async t => {
  const { phone, srv, sid } = await setup(t);
  phone.send(send('seq-phone-0001', { effect: 'sequence', steps: steps3() }));
  assert.equal((await phone.waitFor('error')).code, 'FORBIDDEN');
  assert.equal((await srv.app.sessions.get(sid)).state.stateVersion, 0);
});

test('integración: la secuencia de 12 colores cabe en el límite de mensaje y se publica completa', async t => {
  const { master, phone } = await setup(t);
  const steps = Array.from({ length: 12 }, (_, i) => ({ color: '#' + ((i * 21) % 256).toString(16).padStart(2, '0').toUpperCase() + 'FF00', holdMs: 1000 + i * 100 }));
  master.send(send('seq-max-0001', { effect: 'sequence', steps, fadeMs: 300, durationMs: 60000 }));
  await master.waitFor(m => m.type === 'ack' && m.commandId === 'seq-max-0001');
  const st = await phone.waitFor(m => m.type === 'state' && m.commandId === 'seq-max-0001');
  assert.equal(st.payload.steps.length, 12); assert.equal(st.payload.durationMs, 60000);
});
