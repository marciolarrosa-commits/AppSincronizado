'use strict';
// Multi-evento con Redis REAL y dos instancias (V4.0). Se omite (y se dice) si REDIS_SERVER no está definido.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const { startServer, http, login, joinPublic, joinMaster, sleep, dev } = require('./helpers');

const REDIS_BIN = process.env.REDIS_SERVER || '';
const skip = !REDIS_BIN || !fs.existsSync(REDIS_BIN) ? 'REDIS_SERVER no definido: pruebas de eventos con Redis omitidas (NO verificadas)' : false;

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function startRedis(port) {
  const p = spawn(REDIS_BIN, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await new Promise(r => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); })) return p;
    await sleep(100);
  }
  throw new Error('redis no arrancó');
}
const solid = (color, id) => ({ protocolVersion: 1, type: 'command', commandId: id, leadMs: 300, payload: { effect: 'solid', color, fadeMs: 0 } });

test('Redis, 2 instancias: un evento creado y activado en A se ve y se opera desde B; el cierre llega por Pub/Sub a los teléfonos de OTRA instancia', { skip }, async t => {
  const rport = await freePort(); const redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'ev1:', strobeAllowed: false }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 'ev1:', strobeAllowed: false }); t.after(B.stop);
  const tokA = await login(A.base); const tokB = await login(B.base);

  const e = (await http(A.base, 'POST', '/api/events', { token: tokA, body: { name: 'Estadio', config: { effectsAllowed: ['solid', 'sequence'] } } })).json.event;
  assert.equal((await http(B.base, 'GET', `/api/events/${e.id}`, { token: tokB })).json.event.name, 'Estadio', 'B ve el evento creado en A');
  assert.equal((await http(A.base, 'POST', `/api/events/${e.id}/status`, { token: tokA, body: { status: 'active' } })).json.event.status, 'active');

  // Master en A, teléfonos del MISMO evento repartidos en A y B
  const mt = (await http(A.base, 'POST', `/api/events/${e.id}/master-token`, { token: tokA, body: {} })).json;
  const master = await joinMaster(A.wsUrl, mt.sessionId, mt.masterToken);
  const pa = await joinPublic(A.wsUrl, e.code, dev(1)); const pb = await joinPublic(B.wsUrl, e.code, dev(2));
  master.send(solid('#FF0000', 'cmd-redis-01'));
  assert.equal((await master.waitFor('ack')).stateVersion, 1);
  assert.equal((await pa.waitFor('state')).payload.color, '#FF0000'); assert.equal((await pb.waitFor('state')).payload.color, '#FF0000');

  // la política del evento se aplica también con el Master en otra instancia
  const mtB = (await http(B.base, 'POST', `/api/events/${e.id}/master-token`, { token: tokB, body: {} })).json;
  const masterB = await joinMaster(B.wsUrl, mtB.sessionId, mtB.masterToken);
  masterB.send({ protocolVersion: 1, type: 'command', commandId: 'cmd-redis-02', payload: { effect: 'pulse', color: '#FF0000', color2: '#000000', periodMs: 2000, durationMs: 10000 } });
  assert.equal((await masterB.waitFor('error')).code, 'EFFECT_NOT_ALLOWED');

  // estadísticas y panel general agregan las dos instancias
  await sleep(2500);
  const st = (await http(B.base, 'GET', `/api/events/${e.id}/stats`, { token: tokB })).json;
  assert.equal(st.connected, 2); assert.equal(st.lastOrder.color, '#FF0000');
  const dash = (await http(A.base, 'GET', '/api/events/dashboard', { token: tokA })).json;
  assert.equal(dash.infrastructure.instances, 2, 'las dos instancias se anuncian'); assert.equal(dash.connectedTotal, 2);

  // finalizar desde B: el teléfono de A y el de B reciben el cierre definitivo
  const ca = pa.waitClose(); const cb = pb.waitClose();
  assert.equal((await http(B.base, 'POST', `/api/events/${e.id}/status`, { token: tokB, body: { status: 'finished' } })).json.event.status, 'finished');
  assert.equal((await ca).code, 4410, 'cierre propagado por Pub/Sub a otra instancia'); assert.equal((await cb).code, 4410);
  await sleep(300);
  assert.equal(A.app.hub.stats().rooms, 0); assert.equal(B.app.hub.stats().rooms, 0, 'las salas se liberaron y se dieron de baja del canal');
});

test('Redis, 2 instancias: códigos únicos y edición concurrente atómicos (sin duplicados ni pisotones)', { skip }, async t => {
  const rport = await freePort(); const redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'ev2:' }); t.after(A.stop);
  const B = await startServer({ redisUrl: url, instanceId: 'B', redisPrefix: 'ev2:' }); t.after(B.stop);
  const tokA = await login(A.base); const tokB = await login(B.base);

  // 40 altas simultáneas repartidas en las dos instancias: ningún código ni id repetido
  const made = await Promise.all(Array.from({ length: 40 }, (_, i) => http(i % 2 ? A.base : B.base, 'POST', '/api/events', { token: i % 2 ? tokA : tokB, body: { name: 'E' + i } })));
  assert.ok(made.every(r => r.status === 201), made.filter(r => r.status !== 201).map(r => r.text).join(' | '));
  assert.equal(new Set(made.map(r => r.json.event.code)).size, 40); assert.equal(new Set(made.map(r => r.json.event.id)).size, 40);
  assert.equal((await http(A.base, 'GET', '/api/events', { token: tokA })).json.events.length, 40);

  // una colisión forzada del código se rechaza de forma atómica en el almacenamiento
  const ev0 = made[0].json.event;
  assert.equal(await A.app.store.eventCreate({ id: 'ev_ffffffffffffffff', code: ev0.code, createdAt: Date.now(), config: {}, stats: {} }), false);

  // 12 ediciones simultáneas con la MISMA revisión: exactamente una gana, el resto recibe 409
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => http(i % 2 ? A.base : B.base, 'POST', `/api/events/${ev0.id}/update`, { token: i % 2 ? tokA : tokB, body: { name: 'Nombre ' + i, rev: ev0.rev } })));
  assert.equal(rs.filter(r => r.status === 200).length, 1, rs.map(r => r.status).join(','));
  assert.equal(rs.filter(r => r.status === 409).length, 11);
  assert.equal((await http(A.base, 'GET', `/api/events/${ev0.id}`, { token: tokA })).json.event.rev, ev0.rev + 1);
});

test('Redis reiniciado: los eventos y su auditoría sobreviven al reinicio de una instancia; la sala de un evento activo se recupera al operarlo', { skip }, async t => {
  const rport = await freePort(); const redis = await startRedis(rport); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${rport}`;
  let A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'ev3:' });
  const tok = await login(A.base);
  const e = (await http(A.base, 'POST', '/api/events', { token: tok, body: { name: 'Persistente' } })).json.event;
  await http(A.base, 'POST', `/api/events/${e.id}/status`, { token: tok, body: { status: 'active' } });
  await A.stop();
  A = await startServer({ redisUrl: url, instanceId: 'A2', redisPrefix: 'ev3:' }); t.after(A.stop);
  const tok2 = await login(A.base);
  const again = (await http(A.base, 'GET', `/api/events/${e.id}`, { token: tok2 })).json.event;
  assert.equal(again.name, 'Persistente'); assert.equal(again.status, 'active');
  assert.deepEqual((await http(A.base, 'GET', `/api/events/${e.id}/audit`, { token: tok2 })).json.audit.map(a => a.action), ['status', 'create']);
  const p = await joinPublic(A.wsUrl, e.code, dev(1)); assert.equal(p.welcome.sessionId, e.code);
});
