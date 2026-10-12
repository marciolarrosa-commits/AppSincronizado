'use strict';
// Idempotencia de comandos a nivel de almacenamiento (memoria y Redis REAL): el reenvío de un comando ya procesado
// nunca debe volver a aplicarlo, aunque ya se haya aceptado uno más nuevo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const { createMemoryStore } = require('../src/store/memory');
const { startServer, login, createSession, joinPublic, joinMaster, sleep, dev, http } = require('./helpers');

const REDIS_BIN = process.env.REDIS_SERVER || '';
const redisSkip = !REDIS_BIN || !fs.existsSync(REDIS_BIN) ? 'REDIS_SERVER no definido: parte Redis omitida (NO verificada)' : false;
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
async function startRedis(port) {
  const p = spawn(REDIS_BIN, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await new Promise(r => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); })) return p;
    await sleepMs(100);
  }
  throw new Error('redis no arrancó');
}

const CFG = { sessionTtlS: 600, presenceTtlMs: 3000, onTimeToleranceMs: 100, redisPrefix: 'idem:', maxCommandHistory: 500 };
const payload = c => ({ effect: 'solid', color: c, color2: '#000000', intensity: 1, fadeMs: 0 });
const cmd = (id, color) => ({ commandId: id, executeAt: Date.now() + 1000, serverTimestamp: Date.now(), payload: payload(color) });
const quiet = { warn() {}, info() {}, error() {}, debug() {} };

async function scenarios(store, label) {
  await store.init();
  try { await scenariosBody(store, label); } finally { await store.close(); }
}

async function scenariosBody(store, label) {
  const sid = 'ABCDEF';
  await store.createSession(sid);

  // 1) A, B, reenvío de A => el estado final sigue siendo B
  const a = await store.applyState(sid, cmd('cmd-A-0000001', '#FF0000'));
  const b = await store.applyState(sid, cmd('cmd-B-0000001', '#00FF00'));
  assert.equal(a.state.stateVersion, 1); assert.equal(b.state.stateVersion, 2);
  const a2 = await store.applyState(sid, cmd('cmd-A-0000001', '#FF0000'));
  assert.equal(a2.duplicate, true, `${label}: el reenvío de A debe detectarse como duplicado`);
  assert.equal(a2.state.stateVersion, 1, `${label}: el duplicado informa la versión ORIGINAL de A`);
  const cur = (await store.getSession(sid)).state;
  assert.equal(cur.stateVersion, 2, `${label}: la versión vigente no cambia`);
  assert.equal(cur.payload.color, '#00FF00', `${label}: el estado final sigue siendo B`);

  // 2) los reenvíos repetidos de A y B tampoco cambian nada, y no se publican
  const seen = []; const unsub = store.subscribe(sid, m => seen.push(m)); if (unsub.ready) await unsub.ready;
  for (let i = 0; i < 3; i++) { await store.applyState(sid, cmd('cmd-A-0000001', '#FF0000')); await store.applyState(sid, cmd('cmd-B-0000001', '#00FF00')); }
  await sleepMs(150);
  assert.equal(seen.length, 0, `${label}: los duplicados no se vuelven a publicar`);
  assert.equal((await store.getSession(sid)).state.stateVersion, 2);

  // 3) un comando nuevo sigue funcionando y la versión sigue creciendo sin saltos
  const c = await store.applyState(sid, cmd('cmd-C-0000001', '#0000FF'));
  assert.equal(c.duplicate, false); assert.equal(c.state.stateVersion, 3);
  await unsub();

  // 4) concurrencia: el mismo comando enviado en paralelo se aplica UNA sola vez
  const results = await Promise.all(Array.from({ length: 20 }, () => store.applyState(sid, cmd('cmd-D-0000001', '#FFFF00'))));
  assert.equal(results.filter(r => !r.duplicate).length, 1, `${label}: de 20 envíos concurrentes solo uno se aplica`);
  assert.ok(results.every(r => r.state.stateVersion === 4), `${label}: todos informan la misma versión`);
  assert.equal((await store.getSession(sid)).state.stateVersion, 4);

  // 5) la historia de idempotencia está acotada (memoria limitada)
  for (let i = 0; i < 520; i++) await store.applyState(sid, cmd('cmd-bulk-' + String(i).padStart(6, '0'), '#123456'));
  const hist = await store.commandHistorySize(sid);
  assert.ok(hist <= 500, `${label}: historial acotado (${hist} <= 500)`);
  // lo muy antiguo sale de la ventana (documentado): lo reciente sigue protegido
  const recent = await store.applyState(sid, cmd('cmd-bulk-000519', '#123456'));
  assert.equal(recent.duplicate, true);
}

test('idempotencia (memoria): A, B, reenvío de A conserva B; duplicados no se publican; historial acotado', async () => {
  await scenarios(createMemoryStore(CFG), 'memoria');
});

test('idempotencia (Redis real): A, B, reenvío de A conserva B; atómico bajo concurrencia; historial acotado', { skip: redisSkip }, async t => {
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const { createRedisStore } = require('../src/store/redis');
  await scenarios(createRedisStore({ ...CFG, redisUrl: `redis://127.0.0.1:${port}` }, quiet), 'redis');
});

test('idempotencia entre instancias: el reenvío de A a OTRA instancia tras aceptar B no revierte el estado', { skip: redisSkip }, async t => {
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${port}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'idx:' }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 'idx:' }); t.after(B.stop);
  const op = await login(A.base); const s = await createSession(A.base, op);
  const mA = await joinMaster(A.wsUrl, s.sessionId, s.masterToken);
  const tokB = (await http(B.base, 'POST', `/api/sessions/${s.sessionId}/master-token`, { token: op, body: {} })).json.masterToken;
  const mB = await joinMaster(B.wsUrl, s.sessionId, tokB);
  const phone = await joinPublic(B.wsUrl, s.sessionId, dev(1));
  const color = (id, c) => ({ protocolVersion: 1, type: 'command', commandId: id, payload: { effect: 'solid', color: c, fadeMs: 0 } });
  mA.send(color('orden-A-00000001', '#FF0000')); const ackA = await mA.waitFor('ack');
  mA.send(color('orden-B-00000001', '#00FF00')); const ackB = await mA.waitFor('ack');
  assert.equal(ackB.stateVersion, ackA.stateVersion + 1);
  await phone.waitFor(m => m.type === 'state' && m.stateVersion === ackA.stateVersion);
  await phone.waitFor(m => m.type === 'state' && m.stateVersion === ackB.stateVersion);
  // el Master (en otra instancia) no recibió el ACK de A y lo reenvía
  mB.send(color('orden-A-00000001', '#FF0000')); const again = await mB.waitFor(m => (m.type === 'ack' && m.commandId === 'orden-A-00000001') || (m.type === 'error' && assert.fail('error inesperado: ' + JSON.stringify(m))));
  assert.equal(again.duplicate, true); assert.equal(again.stateVersion, ackA.stateVersion, 'el ACK del duplicado conserva la versión original');
  await sleep(400);
  assert.equal(phone.msgs.filter(m => m.type === 'state').length, 0, 'el teléfono no recibe el estado antiguo');
  const st = (await A.app.sessions.get(s.sessionId)).state;
  assert.equal(st.payload.color, '#00FF00'); assert.equal(st.stateVersion, ackB.stateVersion);
});
