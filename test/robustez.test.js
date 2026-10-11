'use strict';
// Escenarios de pérdida/corrupción de estado hallados en la auditoría de V3.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const Redis = require('ioredis');
const { startServer, http, login, createSession, joinPublic, joinMaster, sleep, dev } = require('./helpers');

const REDIS_BIN = process.env.REDIS_SERVER || '';
const skip = !REDIS_BIN || !fs.existsSync(REDIS_BIN) ? 'REDIS_SERVER no definido: pruebas con Redis omitidas (NO verificadas)' : false;
function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
async function startRedis(port) {
  const p = spawn(REDIS_BIN, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await new Promise(r => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); })) return p;
    await sleep(100);
  }
  throw new Error('redis no arrancó');
}
const color = (id, c) => ({ protocolVersion: 1, type: 'command', commandId: id, payload: { effect: 'solid', color: c, fadeMs: 0 } });

test('Redis pierde sus datos (reinicio del Key Value gratuito) con sesiones vivas: tras re-crear la sesión las órdenes vuelven a llegar', { skip }, async t => {
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${port}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'rb1:' }); t.after(A.stop);
  const op = await login(A.base); const s = await createSession(A.base, op);
  const m1 = await joinMaster(A.wsUrl, s.sessionId, s.masterToken);
  const phone = await joinPublic(A.wsUrl, s.sessionId, dev(1));
  for (let i = 0; i < 3; i++) { m1.send(color('antes-de-perder-0' + i, '#FF0000')); await m1.waitFor('ack'); await phone.waitFor('state'); }   // versión 3

  const r = new Redis(url); await r.flushall(); r.disconnect();        // el almacenamiento se vació; la app NO se reinició
  // el operador re-crea la sesión con el mismo código (flujo del panel) y envía una orden: debe llegar al teléfono ya conectado
  const re = await http(A.base, 'POST', '/api/sessions', { token: op, body: { sessionId: s.sessionId } });
  assert.equal(re.status, 201);
  const m2 = await joinMaster(A.wsUrl, s.sessionId, re.json.masterToken);
  m2.send(color('despues-de-perder-01', '#00FF00'));
  const ack = await m2.waitFor('ack'); assert.equal(ack.stateVersion, 1, 'la sesión nueva empieza en versión 1');
  const st = await phone.waitFor('state', 2500, 'estado de la sesión re-creada');
  assert.equal(st.payload.color, '#00FF00');
});

test('sesión a medio crear en Redis (caída entre dos comandos) no envenena el código: se trata como inexistente y se puede crear', { skip }, async t => {
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${port}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'rb2:' }); t.after(A.stop);
  const op = await login(A.base);
  const r = new Redis(url); await r.hset('rb2:s:ZZZ234', 'id', 'ZZZ234'); r.disconnect();    // restos de una creación interrumpida (sin estado ni TTL)
  const c = await joinPublic(A.wsUrl, 'ZZZ234', dev(1)).catch(e => e);
  assert.ok(c instanceof Error || !c.welcome, 'un registro incompleto no es una sesión válida');
  const re = await http(A.base, 'POST', '/api/sessions', { token: op, body: { sessionId: 'ZZZ234' } });
  assert.equal(re.status, 201, 'el código se puede re-crear: ' + re.text);
});

test('Redis: el suscriptor de una instancia se cae un momento (pub/sub es "como máximo una vez"): al volver, sus teléfonos reciben el estado vigente', { skip, timeout: 60000 }, async t => {
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${port}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'rb3:', reconcileIntervalMs: 60000 }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 'rb3:', reconcileIntervalMs: 60000 }); t.after(B.stop);
  const op = await login(A.base); const s = await createSession(A.base, op);
  const tokB = (await http(B.base, 'POST', `/api/sessions/${s.sessionId}/master-token`, { token: op, body: {} })).json.masterToken;
  const mB = await joinMaster(B.wsUrl, s.sessionId, tokB);
  const phone = await joinPublic(A.wsUrl, s.sessionId, dev(1));          // el teléfono está en la instancia A; el Master en B
  mB.send(color('orden-uno-0000001', '#FF0000')); await mB.waitFor('ack'); await phone.waitFor('state');

  await A.app.store._test.dropSubscriber();                              // A deja de escuchar el canal (red/Redis)
  mB.send(color('orden-dos-0000001', '#00FF00')); await mB.waitFor('ack');
  await sleep(400);
  assert.equal(phone.msgs.filter(m => m.type === 'state').length, 0, 'durante la caída el mensaje publicado se pierde (comportamiento de pub/sub)');
  await A.app.store._test.restoreSubscriber();
  const st = await phone.waitFor(m => m.type === 'state' && m.stateVersion === 2, 4000, 'estado vigente tras recuperar el suscriptor');
  assert.equal(st.payload.color, '#00FF00');
});

test('Redis: red de seguridad periódica — aunque nunca se detecte la caída, la reconciliación entrega el estado que faltó', { skip, timeout: 60000 }, async t => {
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${port}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'rb4:', reconcileIntervalMs: 500 }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 'rb4:', reconcileIntervalMs: 500 }); t.after(B.stop);
  const op = await login(A.base); const s = await createSession(A.base, op);
  const tokB = (await http(B.base, 'POST', `/api/sessions/${s.sessionId}/master-token`, { token: op, body: {} })).json.masterToken;
  const mB = await joinMaster(B.wsUrl, s.sessionId, tokB);
  const phone = await joinPublic(A.wsUrl, s.sessionId, dev(1));
  await A.app.store._test.dropSubscriber();                              // y NO se restaura: solo la reconciliación puede corregirlo
  mB.send(color('orden-tres-000001', '#0000FF')); await mB.waitFor('ack');
  const st = await phone.waitFor(m => m.type === 'state' && m.stateVersion === 1, 4000, 'reconciliación');
  assert.equal(st.payload.color, '#0000FF');
  assert.ok(A.app.metrics.get('reconciled_states') >= 1);
});

test('la reconciliación periódica NO reenvía estados que los teléfonos ya tienen (sin difusiones redundantes)', async t => {
  const srv = await startServer({ reconcileIntervalMs: 200 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const m = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phone = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  m.send(color('orden-uno-0000001', '#FF0000')); await m.waitFor('ack'); await phone.waitFor('state');
  const before = srv.app.metrics.get('state_broadcasts');
  await sleep(1500);                                                      // varias rondas de reconciliación
  assert.equal(srv.app.metrics.get('reconciled_states'), 0);
  assert.equal(srv.app.metrics.get('state_broadcasts'), before, 'ninguna difusión extra');
  assert.equal(phone.msgs.filter(x => x.type === 'state').length, 0);
});
