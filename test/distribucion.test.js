'use strict';
// Pruebas de distribución con DOS instancias de la aplicación y un Redis REAL.
// Requieren un binario redis-server/valkey-server: variable REDIS_SERVER (ruta). Si no existe, las pruebas se OMITEN (no se marcan como exitosas).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const { startServer, http, login, createSession, joinPublic, joinMaster, joinMany, sleep, dev } = require('./helpers');

const REDIS_BIN = process.env.REDIS_SERVER || '';
const skip = !REDIS_BIN || !fs.existsSync(REDIS_BIN) ? 'REDIS_SERVER no definido o inexistente: pruebas de distribución omitidas' : false;

function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }

async function startRedis(port) {
  const p = spawn(REDIS_BIN, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise(r => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); });
    if (ok) return p;
    await sleep(100);
  }
  throw new Error('redis no arrancó');
}

const color = (c, extra = {}) => ({ protocolVersion: 1, type: 'command', payload: { effect: 'solid', color: c, ...extra } });

test('Redis: una orden enviada a la instancia A llega a los dispositivos de la instancia B (y viceversa)', { skip }, async t => {
  const rport = await freePort(); const redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 't1:' }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 't1:' }); t.after(B.stop);
  const op = await login(A.base);                       // el token es válido en B: mismo secreto derivado
  const s = await createSession(A.base, op);
  const mA = await joinMaster(A.wsUrl, s.sessionId, s.masterToken);
  const tokB = (await http(B.base, 'POST', `/api/sessions/${s.sessionId}/master-token`, { token: op, body: {} })).json.masterToken;
  const mB = await joinMaster(B.wsUrl, s.sessionId, tokB);
  const onA = await joinMany(A.wsUrl, s.sessionId, 20, {}, 20, 0);
  const onB = await joinMany(B.wsUrl, s.sessionId, 20, {}, 20, 100);

  mA.send(color('#FF3B30')); const ack1 = await mA.waitFor('ack');
  const gotAll = await Promise.all([...onA, ...onB].map(p => p.waitFor('state')));
  assert.ok(gotAll.every(g => g.stateVersion === ack1.stateVersion && g.payload.color === '#FF3B30'), 'las 40 pantallas reciben la orden');
  await mB.waitFor('state');                            // el Master de la otra instancia también la ve

  mB.send(color('#0A84FF')); const ack2 = await mB.waitFor('ack');
  assert.equal(ack2.stateVersion, ack1.stateVersion + 1, 'versión monotónica compartida entre instancias');
  const got2 = await Promise.all([...onA, ...onB].map(p => p.waitFor('state')));
  assert.ok(got2.every(g => g.stateVersion === ack2.stateVersion && g.payload.color === '#0A84FF'));
});

test('Redis: la presencia suma participantes de todas las instancias y el Master no cuenta', { skip }, async t => {
  const rport = await freePort(); const redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 't2:' }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 't2:' }); t.after(B.stop);
  const s = await createSession(A.base, await login(A.base));
  const m = await joinMaster(A.wsUrl, s.sessionId, s.masterToken);
  await joinMany(A.wsUrl, s.sessionId, 7, {}, 7, 0);
  await joinMany(B.wsUrl, s.sessionId, 5, {}, 5, 100);
  const pres = await m.waitFor(p => p.type === 'presence' && p.connected === 12, 6000, 'presence 12');
  assert.equal(pres.connected, 12);
  assert.equal(pres.localConnected, 7);
});

test('Redis: el estado sobrevive al reinicio de una instancia y las órdenes antiguas no sobrescriben las nuevas', { skip }, async t => {
  const rport = await freePort(); const redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  let A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 't3:' });
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 't3:' }); t.after(B.stop);
  const op = await login(A.base);
  const s = await createSession(A.base, op);
  const m = await joinMaster(A.wsUrl, s.sessionId, s.masterToken);
  m.send(color('#34C759')); await m.waitFor('ack'); m.send(color('#AF52DE')); await m.waitFor('ack');
  const port = A.port;
  await A.stop();                                       // despliegue / reinicio de la instancia A
  A = await startServer({ redisUrl: url, instanceId: 'A2', redisPrefix: 't3:', port }); t.after(A.stop);
  const late = await joinPublic(A.wsUrl, s.sessionId, dev(1), { hello: { reconnect: true } });
  assert.equal(late.welcome.state.stateVersion, 2, 'la sesión y su estado vigente sobreviven al reinicio');
  assert.equal(late.welcome.state.payload.color, '#AF52DE');
  const viaB = await joinPublic(B.wsUrl, s.sessionId, dev(2));
  assert.equal(viaB.welcome.state.stateVersion, 2, 'otro dispositivo, otra instancia: mismo estado');
  const tok = (await http(A.base, 'POST', `/api/sessions/${s.sessionId}/master-token`, { token: op, body: {} })).json.masterToken;
  const m2 = await joinMaster(A.wsUrl, s.sessionId, tok);
  m2.send(color('#FFFFFF')); assert.equal((await m2.waitFor('ack')).stateVersion, 3, 'las versiones siguen creciendo tras el reinicio');
});

test('Redis: commandId duplicado enviado a instancias distintas se aplica una sola vez', { skip }, async t => {
  const rport = await freePort(); const redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 't4:' }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 't4:' }); t.after(B.stop);
  const op = await login(A.base);
  const s = await createSession(A.base, op);
  const mA = await joinMaster(A.wsUrl, s.sessionId, s.masterToken);
  const mB = await joinMaster(B.wsUrl, s.sessionId, (await http(B.base, 'POST', `/api/sessions/${s.sessionId}/master-token`, { token: op, body: {} })).json.masterToken);
  const phone = await joinPublic(B.wsUrl, s.sessionId, dev(1));
  const c = { ...color('#FF9F1C'), commandId: 'orden-unica-0001' };
  mA.send(c); mB.send(c);
  const [a, b] = await Promise.all([mA.waitFor('ack'), mB.waitFor('ack')]);
  assert.equal(a.stateVersion, 1); assert.equal(b.stateVersion, 1);
  assert.equal([a, b].filter(x => x.duplicate).length, 1);
  await phone.waitFor('state'); await sleep(300);
  assert.equal(phone.msgs.filter(m => m.type === 'state').length, 0);
});

test('Redis: las confirmaciones de aplicación se agregan entre instancias', { skip }, async t => {
  const rport = await freePort(); const redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 't5:' }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 't5:' }); t.after(B.stop);
  const s = await createSession(A.base, await login(A.base));
  const m = await joinMaster(A.wsUrl, s.sessionId, s.masterToken);
  const onA = await joinMany(A.wsUrl, s.sessionId, 3, {}, 3, 0);
  const onB = await joinMany(B.wsUrl, s.sessionId, 3, {}, 3, 100);
  m.send(color('#00C7BE')); const ack = await m.waitFor('ack');
  await Promise.all([...onA, ...onB].map(p => p.waitFor('state')));
  [...onA, ...onB].forEach((p, i) => p.send({ protocolVersion: 1, type: 'applied', commandId: ack.commandId, stateVersion: 1, deviationMs: i * 10, receiveLeadMs: 200 }));
  const stats = await m.waitFor(x => x.type === 'stats' && x.responded === 6, 6000, 'stats 6');
  assert.equal(stats.responded, 6); assert.equal(stats.onTime, 6);
});

test('Redis caído: el sistema informa degradación, rechaza órdenes sin perder el proceso y se recupera', { skip }, async t => {
  const rport = await freePort(); let redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 't6:' }); t.after(A.stop);
  const op = await login(A.base);
  const s = await createSession(A.base, op);
  const m = await joinMaster(A.wsUrl, s.sessionId, s.masterToken);
  const phone = await joinPublic(A.wsUrl, s.sessionId, dev(1));
  redis.kill();
  await sleep(500);
  m.send({ ...color('#FF3B30'), commandId: 'cmd-redis-caido-01' });
  const err = await m.waitFor('error', 8000);
  assert.ok(['PUBLISH_FAILED', 'UNAVAILABLE'].includes(err.code), err.code);
  assert.equal(err.commandId, 'cmd-redis-caido-01', 'el error por almacenamiento caído se asocia a SU orden (el panel la cierra como rechazada, no queda «enviando»)');
  assert.equal(m.msgs.filter(x => x.type === 'ack').length, 0, 'no hubo aceptación falsa');
  assert.equal((await http(A.base, 'GET', '/healthz')).status, 200, 'el proceso sigue vivo');
  await sleep(5500);                                      // el sondeo de salud detecta el almacenamiento caído
  assert.equal((await http(A.base, 'GET', '/readyz')).status, 503, 'readyz informa que no está listo');
  const st = (await http(A.base, 'GET', '/api/admin/status', { token: op }));
  assert.equal(st.json.health.status === 'degraded' || st.json.health.status === 'overloaded', true);
  assert.equal(phone.closed, null, 'los teléfonos siguen conectados mostrando el último estado');
  redis = await startRedis(rport);
  await sleep(5500);
  assert.equal((await http(A.base, 'GET', '/readyz')).status, 200, 'se recupera al volver Redis');
});

test('Redis: el interruptor de la app Flash habilitado en la instancia A lo ven la instancia B (≤ 5 s) y una instancia nueva al arrancar', { skip, timeout: 30000 }, async t => {
  const rport = await freePort(); const redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'tf:' }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 'tf:' }); t.after(B.stop);
  assert.equal((await fetch(B.base + '/flash')).status, 403, 'deshabilitada por defecto');
  const op = await login(A.base);
  assert.equal((await http(A.base, 'POST', '/api/admin/flash', { token: op, body: { enabled: true } })).json.enabled, true);
  assert.equal((await fetch(A.base + '/flash')).status, 200, 'la instancia que lo cambió lo aplica al instante');
  let seen = false;
  for (let i = 0; i < 70 && !seen; i++) { seen = (await fetch(B.base + '/flash')).status === 200; if (!seen) await sleep(100); }
  assert.ok(seen, 'la otra instancia lo ve en ≤ 7 s (sondeo de 5 s)');
  const C = await startServer({ redisUrl: url, instanceId: 'C', redisPrefix: 'tf:' }); t.after(C.stop);
  assert.equal((await fetch(C.base + '/flash')).status, 200, 'una instancia nueva lo lee al arrancar');
  await http(B.base, 'POST', '/api/admin/flash', { token: await login(B.base), body: { enabled: false } });
  assert.equal((await fetch(B.base + '/flash')).status, 403);
});

test('Redis: los cuatro efectos con la carga útil EXACTA del panel (solid, fade, pulse, strobe) se aceptan en A y llegan íntegros a un teléfono de B; el strobe sigue exigiendo habilitación', { skip, timeout: 60000 }, async t => {
  const rport = await freePort(); const redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'te:' }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 'te:' }); t.after(B.stop);
  const op = await login(A.base); const s = await createSession(A.base, op);
  const master = await joinMaster(A.wsUrl, s.sessionId, s.masterToken);
  const phone = await joinPublic(B.wsUrl, s.sessionId, dev(1));
  const PANEL = {
    solid: { effect: 'solid', color: '#FFD400', fadeMs: 500 },
    fade: { effect: 'fade', color: '#FFD400', fadeMs: 500, color2: '#0A84FF' },
    pulse: { effect: 'pulse', color: '#FFD400', color2: '#0A84FF', periodMs: 2000, durationMs: 10000 },
    strobe: { effect: 'strobe', color: '#FFD400', color2: '#0A84FF', hz: 2, durationMs: 10000 }
  };
  const send = (id, payload) => master.send({ protocolVersion: 1, type: 'command', commandId: id, leadMs: 300, payload });
  for (const [i, name] of ['solid', 'fade', 'pulse'].entries()) {
    const id = 'redis-fx-' + String(i + 1).padStart(6, '0'); send(id, PANEL[name]);
    const ack = await master.waitFor(m => m.type === 'ack' && m.commandId === id, 4000, 'ack ' + name);
    const st = await phone.waitFor(m => m.type === 'state' && m.commandId === id, 4000, 'estado ' + name + ' en B');
    assert.equal(st.stateVersion, ack.stateVersion); assert.equal(st.payload.effect, name);
    for (const [k, v] of Object.entries(PANEL[name])) assert.equal(st.payload[k], v, `${name}.${k} llegó intacto a la otra instancia`);
  }
  send('redis-fx-strobe-off', PANEL.strobe);
  const e = await master.waitFor('error', 4000); assert.equal(e.code, 'STROBE_DISABLED'); assert.equal(e.commandId, 'redis-fx-strobe-off');
  master.send({ protocolVersion: 1, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: true });
  assert.equal((await master.waitFor('config', 4000)).strobeEnabled, true);
  send('redis-fx-strobe-on', PANEL.strobe);
  await master.waitFor(m => m.type === 'ack' && m.commandId === 'redis-fx-strobe-on', 4000);
  const st = await phone.waitFor(m => m.type === 'state' && m.commandId === 'redis-fx-strobe-on', 4000);
  assert.equal(st.payload.effect, 'strobe'); assert.equal(st.payload.hz, 2); assert.equal(st.payload.duty, 0.25); assert.equal(st.payload.durationMs, 10000);
});

test('Redis: la SECUENCIA de colores se acepta en A y llega íntegra (pasos, tiempos, transición) a un teléfono de B; el reenvío del mismo commandId no la duplica', { skip, timeout: 60000 }, async t => {
  const rport = await freePort(); const redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'tq:' }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 'tq:' }); t.after(B.stop);
  const op = await login(A.base); const s = await createSession(A.base, op);
  const master = await joinMaster(A.wsUrl, s.sessionId, s.masterToken);
  const phone = await joinPublic(B.wsUrl, s.sessionId, dev(1));
  const steps = [{ color: '#75AADB', holdMs: 3000 }, { color: '#FFFFFF', holdMs: 3000 }, { color: '#FF0000', holdMs: 1500 }];
  const msg = { protocolVersion: 1, type: 'command', commandId: 'redis-seq-0001', leadMs: 300, payload: { effect: 'sequence', steps, fadeMs: 500, durationMs: 0 } };
  master.send(msg);
  const ack = await master.waitFor(m => m.type === 'ack' && m.commandId === 'redis-seq-0001', 4000);
  const st = await phone.waitFor(m => m.type === 'state' && m.commandId === 'redis-seq-0001', 4000);
  assert.equal(st.stateVersion, ack.stateVersion); assert.deepEqual(st.payload.steps, steps); assert.equal(st.payload.fadeMs, 500); assert.equal(st.payload.durationMs, 0);
  master.send(msg);
  assert.equal((await master.waitFor(m => m.type === 'ack' && m.commandId === 'redis-seq-0001', 4000)).duplicate, true);
  await sleep(300); assert.equal(phone.msgs.filter(x => x.type === 'state').length, 0, 'el duplicado no se volvió a publicar');
  // un teléfono que se une DESPUÉS recibe la secuencia vigente en la bienvenida (recuperación del estado)
  const late = await joinPublic(B.wsUrl, s.sessionId, dev(2));
  assert.deepEqual(late.welcome.state.payload.steps, steps);
});

test('Redis: relojes de instancia DESFASADOS (+900 / −700 ms): todas las marcas de tiempo (welcome, pong, executeAt) salen de la hora del almacenamiento y los teléfonos de ambas instancias concuerdan', { skip, timeout: 60000 }, async t => {
  const rport = await freePort(); const redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'tc:', clockSkewMs: 900 }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 'tc:', clockSkewMs: -700 }); t.after(B.stop);
  const C = await startServer({ redisUrl: url, instanceId: 'C', redisPrefix: 'tc:', clockSkewMs: 900, clockSource: 'local' }); t.after(C.stop);      // control: SIN corrección
  const op = await login(A.base); const s = await createSession(A.base, op);
  const master = await joinMaster(A.wsUrl, s.sessionId, s.masterToken);
  const pa = await joinPublic(A.wsUrl, s.sessionId, dev(1)); const pb = await joinPublic(B.wsUrl, s.sessionId, dev(2)); const pc = await joinPublic(C.wsUrl, s.sessionId, dev(3));
  // este proceso comparte equipo (y reloj) con Redis: Date.now() es la referencia real
  const errOf = async p => { p.send({ protocolVersion: 1, type: 'ping', t0: 10 }); const pong = await p.waitFor('pong'); return pong.serverTimestamp - Date.now(); };
  const ea = await errOf(pa), eb = await errOf(pb), ec = await errOf(pc);
  assert.ok(Math.abs(ea) < 40, `instancia A (+900 ms) corregida: ${ea.toFixed(1)} ms`); assert.ok(Math.abs(eb) < 40, `instancia B (−700 ms) corregida: ${eb.toFixed(1)} ms`);
  assert.ok(ec > 800, `control sin corrección (clockSource=local): el desfase se ve completo (${ec.toFixed(0)} ms)`);
  for (const [p, nombre] of [[pa, 'A'], [pb, 'B']]) assert.ok(Math.abs(p.welcome.serverTimestamp - Date.now()) < 400 && p.welcome.serverTimestamp > 0, 'welcome de ' + nombre);
  assert.ok(Math.abs(pa.welcome.serverTimestamp - pb.welcome.serverTimestamp) < 300, 'welcome de A y B concuerdan (diferían 1600 ms sin corrección)');
  // executeAt: la orden se acepta en A y la ve el teléfono de B; ambos ven el MISMO instante, y es el real (≈ ahora + margen)
  const t0 = Date.now();
  master.send({ protocolVersion: 1, type: 'command', commandId: 'clk-cmd-0001', leadMs: 2000, payload: { effect: 'solid', color: '#FFFFFF', fadeMs: 0 } });
  const stA = await pa.waitFor(m => m.type === 'state' && m.commandId === 'clk-cmd-0001', 4000); const stB = await pb.waitFor(m => m.type === 'state' && m.commandId === 'clk-cmd-0001', 4000);
  assert.equal(stA.executeAt, stB.executeAt);
  assert.ok(stA.executeAt - t0 > 1900 && stA.executeAt - t0 < 2400, `executeAt ≈ ahora + 2 s en tiempo REAL (no desfasado ${900} ms): ${stA.executeAt - t0} ms`);
  // el desfase detectado queda visible para el operador
  const stat = async (base) => (await fetch(base + '/api/admin/status', { headers: { authorization: 'Bearer ' + op } })).json();
  const sa = (await stat(A.base)).clock, sb = (await stat(B.base)).clock, sc = (await stat(C.base)).clock;
  assert.equal(sa.source, 'store'); assert.ok(Math.abs(sa.offsetMs + 900) < 40, 'A corrige ≈ −900 ms: ' + sa.offsetMs); assert.ok(Math.abs(sb.offsetMs - 700) < 40, 'B corrige ≈ +700 ms: ' + sb.offsetMs);
  assert.equal(sc.source, 'local'); assert.equal(sc.offsetMs, 0);
});
