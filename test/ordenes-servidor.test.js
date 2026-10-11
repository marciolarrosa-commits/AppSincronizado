'use strict';
// INTEGRACIÓN: servidor real (HTTP + WebSocket + hub + almacenamiento en memoria) con clientes WebSocket reales.
// Reproduce los defectos de «órdenes que quedan en ENVIANDO…»: descarte por límite sin respuesta, errores sin commandId, fallos de publicación,
// confirmaciones de aplicación, y verifica los cuatro efectos de extremo a extremo hasta la evaluación en el cliente del teléfono (effects.js real).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, http, login, createSession, joinPublic, joinMaster, Client, sleep, dev } = require('./helpers');
const { createMemoryStore } = require('../src/store/memory');
const { loadConfig } = require('../src/config');
const FX = require('../public/js/effects');
const { createOrders } = require('../public/js/orders');

const cid = n => 'ord-' + String(n).padStart(8, '0');
const cmd = (id, payload, extra = {}) => ({ protocolVersion: 1, type: 'command', commandId: id, leadMs: 300, payload, ...extra });
const SOLID = { effect: 'solid', color: '#FFD400', fadeMs: 500 };
// Cargas útiles EXACTAS que arma el panel (public/js/master.js → sendCommand) con sus valores por defecto.
const PANEL = {
  solid: SOLID,
  fade: { effect: 'fade', color: '#FFD400', fadeMs: 500, color2: '#0A84FF' },
  pulse: { effect: 'pulse', color: '#FFD400', color2: '#0A84FF', periodMs: 2000, durationMs: 10000 },
  strobe: { effect: 'strobe', color: '#FFD400', color2: '#0A84FF', hz: 2, durationMs: 10000 }
};
const frames = (c, type) => c.msgs.filter(m => m.type === type);
async function setup(t, overrides = {}, deps = {}) {
  const srv = await startServer({ wsConnectPerMinPerIp: 1e6, httpPerMin: 1e6, ...overrides }, deps); t.after(srv.stop);
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  return { srv, op, s, master, sid: s.sessionId };
}
const versionOf = async (srv, sid) => (await srv.app.sessions.get(sid)).state.stateVersion;

// ------------------------------------------------------------------------------------------------ A. límite de frecuencia
test('A1) un Master que supera el límite general: sus órdenes descartadas se RESPONDEN con RATE_LIMITED + su commandId (respuestas acotadas, sin cerrar la conexión)', async t => {
  const { srv, master } = await setup(t, { masterCommandsPerSec: 1, masterCommandBurst: 1 });      // límite de órdenes 1/s (ráfaga 1) y general 4/s (ráfaga 4)
  const ids = Array.from({ length: 14 }, (_, i) => cid(i + 1));
  for (const id of ids) master.send(cmd(id, { ...SOLID, fadeMs: 0 }));
  await sleep(1200);
  const acks = frames(master, 'ack'); const errs = frames(master, 'error');
  assert.equal(acks.length, 1, 'solo la primera orden cabe en el cupo de órdenes');
  assert.ok(errs.length >= 7 && errs.length <= 8, 'RATE_LIMITED de cupo de órdenes (3) + de límite general (hasta 4 respuestas acotadas): ' + errs.length);
  for (const e of errs) { assert.equal(e.code, 'RATE_LIMITED'); assert.ok(ids.includes(e.commandId), 'el error lleva el commandId de SU orden'); }
  const answered = new Set([...acks.map(a => a.commandId), ...errs.map(e => e.commandId)]);
  assert.equal(answered.size, acks.length + errs.length, 'ninguna orden recibe dos respuestas');
  // lo que no se pudo responder (presupuesto agotado) se contabiliza: el panel lo resolverá por timeout
  const m = srv.app.metrics;
  assert.equal(m.get('rate_limited_replies') + m.get('rate_limited_replies_suppressed'), m.get('rate_limited'), 'cada descarte por límite general o se respondió o se contó como suprimido');
  assert.ok(m.get('rate_limited_replies_suppressed') >= 1, 'el presupuesto de respuestas es finito');
  assert.equal(master.closed, null, 'por debajo de 20 infracciones la conexión sigue abierta');
});

test('A2) inundación de un Master: no hay amplificación (pocas respuestas) y la conexión se corta con 4429', async t => {
  const { srv, master } = await setup(t, { masterCommandsPerSec: 1, masterCommandBurst: 1 });
  for (let i = 0; i < 300; i++) master.send(cmd(cid(i + 1), { ...SOLID, fadeMs: 0 }));
  await sleep(1500);
  assert.equal(master.closed && master.closed.code, 4429);
  const replies = frames(master, 'error').length;
  assert.ok(replies <= 12, `respuestas de error acotadas: ${replies} para 300 mensajes`);
  assert.ok(srv.app.metrics.get('rate_limited_replies_suppressed') >= 10, 'lo que excede el presupuesto de respuestas se descarta sin responder');
});

test('A3) telemetría de un participante (ping/applied) que excede el límite se descarta SIN responder; órdenes sin commandId tampoco se responden', async t => {
  const { srv, master, sid } = await setup(t);
  const phone = await joinPublic(srv.wsUrl, sid, dev(1));
  for (let i = 0; i < 80; i++) phone.send({ protocolVersion: 1, type: 'ping', t0: i });
  await sleep(800);
  assert.equal(frames(phone, 'error').length, 0, 'los participantes no reciben errores por inundar telemetría');
  assert.ok(srv.app.metrics.get('rate_limited_unanswered') > 0);
  assert.equal(phone.closed && phone.closed.code, 4429);
  // un Master que inunda con órdenes SIN commandId: nada que asociar -> se descarta y se registra (no se inventa un identificador)
  const before = srv.app.metrics.get('rate_limited_unanswerable');
  for (let i = 0; i < 120; i++) master.send({ protocolVersion: 1, type: 'command', payload: { ...SOLID, fadeMs: 0 } });
  await sleep(800);
  assert.ok(srv.app.metrics.get('rate_limited_unanswerable') > before);
  assert.ok(frames(master, 'error').every(e => !('commandId' in e)), 'ningún error inventa un commandId');
});

// ------------------------------------------------------------------------------------------------ B. errores con y sin commandId
test('B) errores de protocolo: con commandId válido se asocian a su orden; con identificador inválido o inexistente NO se refleja ni se inventa', async t => {
  const { srv, master, sid } = await setup(t);
  const state0 = await versionOf(srv, sid);
  // validación del payload + commandId válido
  master.send(cmd('cmd-valid-0001', { effect: 'solid', color: 'rojo' }));
  let e = await master.waitFor('error'); assert.equal(e.code, 'INVALID_COLOR'); assert.equal(e.commandId, 'cmd-valid-0001');
  master.send(cmd('cmd-valid-0002', { effect: 'fade', color: '#FFFFFF', fadeMs: 20000 }));
  e = await master.waitFor('error'); assert.equal(e.code, 'OUT_OF_RANGE'); assert.equal(e.commandId, 'cmd-valid-0002');
  master.send(cmd('cmd-valid-0003', { effect: 'solid', color: '#FFFFFF', inventado: 1 }));
  e = await master.waitFor('error'); assert.equal(e.code, 'UNKNOWN_FIELD'); assert.equal(e.commandId, 'cmd-valid-0003');
  // commandId con formato inválido / tipo inválido / demasiado largo: error de campo SIN commandId (no se refleja el valor del cliente)
  for (const bad of ['mal id!', { a: 1 }, 123, 'x'.repeat(200), 'corto']) {
    master.send(cmd(bad, { ...SOLID }));
    e = await master.waitFor('error'); assert.equal(e.code, 'INVALID_FIELD'); assert.equal('commandId' in e, false, 'sin commandId para ' + JSON.stringify(bad).slice(0, 30));
    assert.ok(!JSON.stringify(e).includes('mal id') && !JSON.stringify(e).includes('xxxxxxxx'), 'el valor inválido no se refleja');
  }
  // versión de protocolo no soportada (error del envoltorio): se asocia a la orden si trae un commandId válido
  master.send({ protocolVersion: 99, type: 'command', commandId: 'cmd-vers-0001', payload: SOLID });
  e = await master.waitFor('error'); assert.equal(e.code, 'UNSUPPORTED_VERSION'); assert.equal(e.commandId, 'cmd-vers-0001');
  // JSON inválido: no hay nada que asociar (límite de 1 error sin id por segundo)
  await sleep(1100);
  master.ws.send('esto no es json {');
  e = await master.waitFor('error'); assert.equal(e.code, 'INVALID_JSON'); assert.equal('commandId' in e, false);
  // tipo desconocido (aunque traiga commandId): no es una orden reconocible, no se asocia
  await sleep(1100);
  master.send({ protocolVersion: 1, type: 'comand', commandId: 'cmd-typo-0001' });
  e = await master.waitFor('error'); assert.equal(e.code, 'UNKNOWN_TYPE'); assert.equal('commandId' in e, false);
  // setConfig sin confirmar el riesgo y stop con identificador inválido
  master.send({ protocolVersion: 1, type: 'setConfig', strobeEnabled: true });
  e = await master.waitFor(m => m.type === 'error' && m.code === 'RISK_NOT_ACKNOWLEDGED'); assert.equal('commandId' in e, false);
  master.send({ protocolVersion: 1, type: 'stop', commandId: 'x' });
  e = await master.waitFor(m => m.type === 'error' && m.code === 'INVALID_FIELD'); assert.equal('commandId' in e, false);
  assert.equal(await versionOf(srv, sid), state0, 'ningún error alteró el estado de la sesión');
  assert.equal(frames(master, 'ack').length, 0, 'ninguna orden inválida fue «aceptada»');
});

// ------------------------------------------------------------------------------------------------ C. almacenamiento / publicación
function faultyStore() {
  const cfg = { ...loadConfig({}), sessionTtlS: 600 };
  const base = createMemoryStore(cfg); const fail = { apply: false, get: false };
  const wrap = (name, flag) => async (...a) => { if (fail[flag]) throw new Error('almacenamiento caído (simulado)'); return base[name](...a); };
  const store = { ...base, applyState: wrap('applyState', 'apply'), getSession: wrap('getSession', 'get') };
  return { store, fail, base };
}

test('C) publicación/almacenamiento caído: PUBLISH_FAILED con el commandId, ninguna aceptación falsa ni estado a medias; el reintento del MISMO commandId se aplica una sola vez', async t => {
  const { store, fail } = faultyStore();
  const { srv, master, sid, s } = await setup(t, {}, { store });
  const phone = await joinPublic(srv.wsUrl, sid, dev(1));
  fail.apply = true;
  master.send(cmd(cid(1), SOLID));
  const e = await master.waitFor('error'); assert.equal(e.code, 'PUBLISH_FAILED'); assert.equal(e.commandId, cid(1));
  await sleep(300);
  assert.equal(frames(master, 'ack').length, 0, 'el servidor NO confirmó una orden que no pudo publicar');
  assert.equal(frames(phone, 'state').length, 0, 'el teléfono no recibió nada');
  fail.apply = false;
  assert.equal(await versionOf(srv, sid), 0, 'el estado de la sesión quedó intacto (versión 0)');
  master.send(cmd(cid(1), SOLID));                                      // reintento del panel (mismo commandId)
  const ack = await master.waitFor('ack'); assert.equal(ack.commandId, cid(1)); assert.equal(ack.stateVersion, 1); assert.equal(ack.duplicate, false);
  await phone.waitFor(m => m.type === 'state' && m.commandId === cid(1));
  master.send(cmd(cid(1), SOLID));                                      // y un reenvío más: idempotente
  const dup = await master.waitFor('ack'); assert.equal(dup.duplicate, true); assert.equal(dup.stateVersion, 1);
  await sleep(200); assert.equal(frames(phone, 'state').length, 0, 'el duplicado no se volvió a publicar');
  // el almacenamiento no responde al LEER la sesión: también se informa con el commandId
  fail.get = true;
  master.send(cmd(cid(2), SOLID));
  const e2 = await master.waitFor('error'); assert.equal(e2.code, 'PUBLISH_FAILED'); assert.equal(e2.commandId, cid(2));
  // y un participante nuevo recibe UNAVAILABLE y se le cierra con 1013 (reintentará)
  const late = await new Client(srv.wsUrl).open();
  late.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: sid, deviceId: dev(9) });
  const un = await late.waitFor('error'); assert.equal(un.code, 'UNAVAILABLE');
  await sleep(300);
  assert.equal(late.closed && late.closed.code, 1013);
  assert.equal(phone.closed, null, 'los teléfonos ya conectados siguen conectados');
  fail.get = false;
  assert.equal(srv.app.metrics.get('commands_failed') >= 2, true);
  assert.ok(!JSON.stringify(srv.logs).includes(s.masterToken), 'los logs de error no contienen el token de Master');
});

// ------------------------------------------------------------------------------------------------ D. los cuatro efectos de extremo a extremo
test('D) los cuatro efectos: validación -> aceptación -> publicación -> recepción -> evaluación en el cliente -> confirmación de aplicación', async t => {
  const { srv, master, sid } = await setup(t);
  const phone = await joinPublic(srv.wsUrl, sid, dev(1));
  const rgb = h => FX.hex(h);
  const near = (a, b, tol = 1) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const at = (st, ms, ctx) => FX.evaluate(st, st.executeAt + ms, ctx).rgb;

  async function run(n, payload) {
    master.send(cmd(cid(n), payload));
    const ack = await master.waitFor(m => m.type === 'ack' && m.commandId === cid(n));
    const st = await phone.waitFor(m => m.type === 'state' && m.commandId === cid(n));
    assert.equal(st.stateVersion, ack.stateVersion, 'el teléfono recibió la versión que el servidor aceptó');
    assert.ok(FX.validPayload(st.payload), 'el cliente acepta la carga útil (validPayload)');
    assert.equal(st.ackRate, 1);
    // el teléfono confirma la aplicación -> el Master recibe las estadísticas de ESA versión
    phone.send({ protocolVersion: 1, type: 'applied', commandId: st.commandId, stateVersion: st.stateVersion, deviationMs: 7, receiveLeadMs: 250 });
    const stats = await master.waitFor(m => m.type === 'stats' && m.stateVersion === st.stateVersion && m.responded >= 1, 4500, 'stats de la versión ' + st.stateVersion);
    assert.equal(stats.responded, 1); assert.equal(stats.connected, 1);
    return st;
  }

  // SOLID: del color actual (negro) al color pedido en fadeMs
  let st = await run(1, PANEL.solid);
  assert.equal(st.payload.effect, 'solid'); assert.equal(st.payload.fadeMs, 500);
  assert.ok(near(at(st, 0, { from: [0, 0, 0] }), [0, 0, 0])); assert.ok(near(at(st, 500, { from: [0, 0, 0] }), rgb('#FFD400')));
  assert.ok(near(at(st, 5000), rgb('#FFD400')));

  // FADE: color -> color2 durante fadeMs y se queda en color2
  st = await run(2, PANEL.fade);
  assert.equal(st.payload.effect, 'fade'); assert.equal(st.payload.color2, '#0A84FF'); assert.equal(st.payload.fadeMs, 500);
  assert.ok(near(at(st, 0), rgb('#FFD400'))); assert.ok(near(at(st, 500), rgb('#0A84FF')), 'termina en color2');
  const mid = at(st, 250); assert.ok(mid[0] < 255 && mid[0] > 10 && mid[2] > 0 && mid[2] < 255, 'a mitad de camino está mezclado: ' + mid.map(Math.round));

  // PULSE: período 2 s entre color2 (mínimo) y color (máximo); termina en color fijo a los durationMs
  st = await run(3, PANEL.pulse);
  assert.equal(st.payload.periodMs, 2000); assert.equal(st.payload.durationMs, 10000);
  assert.ok(near(at(st, 0), rgb('#FFD400'))); assert.ok(near(at(st, 1000), rgb('#0A84FF')), 'medio período = color2'); assert.ok(near(at(st, 2000), rgb('#FFD400')));
  assert.ok(near(at(st, 10500), rgb('#FFD400')), 'tras durationMs vuelve a color fijo');

  // STROBE: deshabilitado por defecto -> RECHAZADO con commandId y sin cambiar el estado
  const v = await versionOf(srv, sid);
  master.send(cmd(cid(4), PANEL.strobe));
  let err = await master.waitFor('error'); assert.equal(err.code, 'STROBE_DISABLED'); assert.equal(err.commandId, cid(4));
  assert.equal(await versionOf(srv, sid), v);
  // habilitarlo exige confirmar la advertencia; luego funciona respetando frecuencia y duración
  master.send({ protocolVersion: 1, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: true });
  const conf = await master.waitFor('config'); assert.equal(conf.strobeEnabled, true);
  st = await run(5, PANEL.strobe);
  assert.equal(st.payload.effect, 'strobe'); assert.equal(st.payload.hz, 2); assert.equal(st.payload.duty, 0.25); assert.equal(st.payload.durationMs, 10000);
  assert.ok(near(at(st, 0), rgb('#FFD400')), 'encendido al inicio del ciclo'); assert.ok(near(at(st, 200), rgb('#0A84FF')), 'apagado (color2) pasado el duty'); assert.ok(near(at(st, 500), rgb('#FFD400')), 'nuevo ciclo a 2 Hz');
  assert.ok(near(at(st, 10001), rgb('#FFD400')), 'tras la duración máxima queda en color fijo');
  // protecciones intactas: frecuencia > máx, duración > máx (el caso que el panel permitía) y períodos fuera de rango se RECHAZAN con commandId
  const v2 = await versionOf(srv, sid);
  const bad = [
    [cid(6), { ...PANEL.strobe, hz: 5 }, 'OUT_OF_RANGE'], [cid(7), { ...PANEL.strobe, durationMs: 60000 }, 'OUT_OF_RANGE'],
    [cid(8), { ...PANEL.pulse, periodMs: 300 }, 'OUT_OF_RANGE'], [cid(9), { ...PANEL.fade, fadeMs: 15000 }, 'OUT_OF_RANGE']
  ];
  for (const [id, payload, code] of bad) { master.send(cmd(id, payload)); const e = await master.waitFor(m => m.type === 'error' && m.commandId === id); assert.equal(e.code, code); }
  assert.equal(await versionOf(srv, sid), v2, 'las órdenes fuera de rango no cambiaron el estado');
  // DETENER TODO: llega y apaga
  master.send({ protocolVersion: 1, type: 'stop', commandId: cid(10) });
  assert.equal((await master.waitFor(m => m.type === 'ack' && m.commandId === cid(10))).duplicate, false);
  st = await phone.waitFor(m => m.type === 'state' && m.commandId === cid(10)); assert.equal(st.payload.effect, 'off');
});

// ------------------------------------------------------------------------------------------------ E. confirmaciones de dispositivos
test('E1) confirmaciones PARCIALES: solo cuentan las válidas, una por dispositivo y de ESA orden; el panel lo interpreta como «parcial»', async t => {
  const { srv, master, sid } = await setup(t);
  const phones = await Promise.all([1, 2, 3, 4].map(n => joinPublic(srv.wsUrl, sid, dev(n))));
  master.send(cmd(cid(1), { ...SOLID, fadeMs: 0 }));
  const ack = await master.waitFor('ack');
  const sts = await Promise.all(phones.map(p => p.waitFor('state')));
  const a = (st, extra = {}) => ({ protocolVersion: 1, type: 'applied', commandId: st.commandId, stateVersion: st.stateVersion, deviationMs: 4, receiveLeadMs: 200, ...extra });
  phones[0].send(a(sts[0]));
  phones[1].send(a(sts[1])); phones[1].send(a(sts[1])); phones[1].send(a(sts[1]));      // duplicada: cuenta UNA vez
  phones[2].send(a(sts[2], { commandId: 'otra-orden-0001' }));                       // commandId ajeno: se ignora
  // phones[3] no responde
  const seen = [];
  const end = Date.now() + 4000;
  while (Date.now() < end) { try { seen.push(await master.waitFor(m => m.type === 'stats' && m.stateVersion === ack.stateVersion, 1500)); } catch { break; } }
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(s => s.responded <= 2), 'nunca más de 2 confirmaciones válidas: ' + seen.map(s => s.responded));
  const last = seen[seen.length - 1]; assert.equal(last.responded, 2); assert.equal(last.connected, 4);
  const m = srv.app.metrics; assert.ok(m.get('applied_duplicate') >= 2); assert.ok(m.get('applied_mismatch') >= 1);
  // lectura del panel con el mismo módulo del navegador: 2 de ~4 = parcial (y, vencido el plazo, sigue siendo parcial, nunca «aplicada»)
  let now = Date.now(); const o = createOrders({ now: () => now, applyGraceMs: 100 });
  o.create({ id: ack.commandId, effect: 'solid' }); o.accepted(ack); o.state({ commandId: ack.commandId, stateVersion: ack.stateVersion, ackRate: sts[0].ackRate }); o.applied(last);
  now += 60000; o.tick();
  const rec = o.current(); assert.equal(rec.dev.phase, 'partial'); assert.equal(rec.dev.final, true); assert.match(o.describeDevices(rec).text, /^APLICADA PARCIALMENTE: 2 de ~4/);
});

test('E2) ningún dispositivo confirma: las estadísticas lo dicen (responded 0) y el panel termina en «sin confirmación», no en «aplicada»', async t => {
  const { srv, master, sid } = await setup(t);
  await joinPublic(srv.wsUrl, sid, dev(1));
  master.send(cmd(cid(1), { ...SOLID, fadeMs: 0 }));
  const ack = await master.waitFor('ack');
  const s = await master.waitFor(m => m.type === 'stats' && m.stateVersion === ack.stateVersion, 3000);
  assert.equal(s.responded, 0); assert.equal(s.connected, 1);
  let now = Date.now(); const o = createOrders({ now: () => now, applyGraceMs: 100 });
  o.create({ id: ack.commandId, effect: 'solid' }); o.accepted(ack); o.applied(s); now += 5000; o.tick();
  assert.equal(o.current().dev.phase, 'none'); assert.match(o.describeDevices(o.current()).text, /SIN CONFIRMACIÓN DE DISPOSITIVOS/);
});

test('E3) desconexión y reconexión del participante: recibe el estado VIGENTE al volver (no repite órdenes viejas) y solo cuenta para la versión actual', async t => {
  const { srv, master, sid } = await setup(t);
  const b = await joinPublic(srv.wsUrl, sid, dev(2));
  let a = await joinPublic(srv.wsUrl, sid, dev(1));
  master.send(cmd(cid(1), { ...SOLID, color: '#FF3B30', fadeMs: 0 })); await master.waitFor('ack');
  await a.waitFor('state'); await b.waitFor('state');
  a.ws.close(); await sleep(250);
  assert.equal(srv.app.hub.stats().public, 1, 'el servidor ya no cuenta al desconectado');
  master.send(cmd(cid(2), { ...SOLID, color: '#34C759', fadeMs: 0 })); const ack2 = await master.waitFor(m => m.type === 'ack' && m.commandId === cid(2));
  await b.waitFor(m => m.type === 'state' && m.commandId === cid(2));
  a = await joinPublic(srv.wsUrl, sid, dev(1), { hello: { reconnect: true, resumeVersion: 1 } });
  assert.equal(a.welcome.state.stateVersion, 2, 'la bienvenida trae la orden vigente'); assert.equal(a.welcome.state.commandId, cid(2)); assert.equal(a.welcome.state.payload.color, '#34C759');
  await sleep(200); assert.equal(frames(a, 'state').length, 0, 'no se le reenviaron las órdenes anteriores');
  // ambos confirman la versión 2; una confirmación atrasada de la 1 no suma a la 2
  a.send({ protocolVersion: 1, type: 'applied', commandId: cid(2), stateVersion: 2, deviationMs: 3 });
  b.send({ protocolVersion: 1, type: 'applied', commandId: cid(2), stateVersion: 2, deviationMs: 5 });
  a.send({ protocolVersion: 1, type: 'applied', commandId: cid(1), stateVersion: 1, deviationMs: 3 });
  const s = await master.waitFor(m => m.type === 'stats' && m.stateVersion === ack2.stateVersion && m.responded === 2, 4500);
  assert.equal(s.connected, 2);
  // el Master que se desconecta y vuelve también recupera el estado vigente
  master.ws.close(); await sleep(200);
  const op2 = await login(srv.base); const again = await http(srv.base, 'POST', `/api/sessions/${sid}/master-token`, { token: op2, body: {} });
  const m2 = await joinMaster(srv.wsUrl, sid, again.json.masterToken);
  assert.equal(m2.welcome.state.stateVersion, 2);
});

// ------------------------------------------------------------------------------------------------ F. seguridad
test('F) seguridad: un participante no puede dar órdenes, parar, habilitar strobe ni cambiar el estado; un token revocado recibe UNAUTHORIZED con el commandId', async t => {
  const { srv, op, master, sid } = await setup(t);
  const phone = await joinPublic(srv.wsUrl, sid, dev(1));
  const v0 = await versionOf(srv, sid);
  const before = srv.app.metrics.get('forbidden_commands');
  phone.send(cmd(cid(1), SOLID)); await sleep(60);
  phone.send({ protocolVersion: 1, type: 'stop', commandId: cid(2) }); await sleep(60);
  phone.send({ protocolVersion: 1, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: true });
  const e = await phone.waitFor('error'); assert.equal(e.code, 'FORBIDDEN'); assert.ok(!('commandId' in e), 'al participante no se le refleja nada');
  await sleep(200);
  assert.equal(srv.app.metrics.get('forbidden_commands') - before, 3);
  assert.equal(await versionOf(srv, sid), v0, 'el estado no cambió'); assert.equal((await srv.app.sessions.get(sid)).strobeEnabled, false);
  assert.equal(frames(master, 'ack').length, 0);
  // el Master no puede enviar confirmaciones de aplicación (solo los participantes)
  master.send({ protocolVersion: 1, type: 'applied', commandId: cid(1), stateVersion: 1, deviationMs: 1 });
  assert.equal((await master.waitFor('error')).code, 'FORBIDDEN');
  // el operador revoca los tokens: la orden siguiente se rechaza con su commandId y la conexión se cierra (4401)
  assert.equal((await http(srv.base, 'POST', `/api/sessions/${sid}/revoke`, { token: op, body: {} })).status, 200);
  await sleep(1100);
  master.send(cmd(cid(3), SOLID));
  const u = await master.waitFor(m => m.type === 'error' && m.code === 'UNAUTHORIZED'); assert.equal(u.commandId, cid(3));
  await sleep(200); assert.equal(master.closed && master.closed.code, 4401);
  assert.equal(await versionOf(srv, sid), v0);
});
