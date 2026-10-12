'use strict';
// Con Redis REAL (REDIS_SERVER): límites compartidos entre instancias (y la diferencia con el modo local), atomicidad bajo concurrencia, caída de Redis sin
// caída del servicio, revocación compartida, protocolo RESP2 explícito, validación de lo que llega de Redis y salas no creadas para sesiones inexistentes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const Redis = require('ioredis');
const { startServer, http, login, createSession, joinPublic, joinMaster, Client, sleep, dev } = require('./helpers');
const { redisOptions } = require('../src/store/redis');
const { isBusMessage } = require('../src/store/common');

const REDIS_BIN = process.env.REDIS_SERVER || '';
const redisSkip = !REDIS_BIN || !fs.existsSync(REDIS_BIN) ? 'REDIS_SERVER no definido: parte Redis omitida (NO verificada)' : false;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const fakeCode = i => 'Q' + [4, 3, 2, 1, 0].map(k => ALPHA[Math.floor(i / 32 ** k) % 32]).join('');
function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
async function startRedis(port) {
  const p = spawn(REDIS_BIN, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await new Promise(r => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); })) return p;
    await sleep(100);
  }
  throw new Error('redis no arrancó');
}
// Clientes Redis de apoyo de las pruebas: sin manejador de 'error' ioredis imprime ruido al matar el servidor al final de cada prueba
const quiet = c => { c.on('error', () => {}); return c; };
const badLogin = (srv, n = 1) => Promise.all(Array.from({ length: n }, () => http(srv.base, 'POST', '/api/master/login', { body: { password: 'mal' } }).then(r => r.status)));

test('protocolo Redis: RESP2 explícito (ioredis 6 usa RESP3 por defecto) y un cliente real lo usa de punta a punta (comandos, EVAL, pub/sub)', { skip: redisSkip, timeout: 30000 }, async t => {
  assert.equal(redisOptions().protocol, 2, 'protocol: 2 fijado en las opciones de conexión');
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const cmd = quiet(new Redis(`redis://127.0.0.1:${port}`, redisOptions())); const sub = quiet(new Redis(`redis://127.0.0.1:${port}`, redisOptions())); t.after(() => { cmd.disconnect(); sub.disconnect(); });
  await cmd.connect(); await sub.connect();
  assert.equal(await cmd.ping(), 'PONG'); assert.deepEqual(await cmd.eval("return {1,'x'}", 0), [1, 'x']);
  await cmd.hset('k', 'a', '1'); assert.deepEqual(await cmd.hgetall('k'), { a: '1' });
  const got = new Promise(res => sub.on('message', (ch, m) => res([ch, m]))); await sub.subscribe('c'); await cmd.publish('c', 'hola');
  assert.deepEqual(await got, ['c', 'hola']);
  assert.equal(cmd.options.protocol, 2); assert.equal(sub.options.protocol, 2);
});

test('límite compartido: 2 instancias + Redis real — los intentos de login se cuentan JUNTOS (con modo local, cada instancia permite el máximo: se multiplica)', { skip: redisSkip, timeout: 60000 }, async t => {
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const common = { redisUrl: `redis://127.0.0.1:${port}`, redisPrefix: 'sh:', loginPerMin: 4, loginGlobalFailPerMin: 1000 };
  const A = await startServer({ ...common, instanceId: 'A' }); t.after(A.stop); const B = await startServer({ ...common, instanceId: 'B' }); t.after(B.stop);
  const r = []; r.push(...await badLogin(A, 2)); r.push(...await badLogin(B, 2)); assert.deepEqual(r, [401, 401, 401, 401]);
  assert.equal((await badLogin(A))[0], 429, 'el 5.º intento llega a A pero ya se gastó el cupo conjunto'); assert.equal((await badLogin(B))[0], 429, 'y también en B');
  // control: modo local = el límite efectivo se multiplica por el número de instancias (documentado)
  const L = { redisUrl: `redis://127.0.0.1:${port}`, redisPrefix: 'lo:', loginPerMin: 4, loginGlobalFailPerMin: 1000, rateLimitBackend: 'local' };
  const C = await startServer({ ...L, instanceId: 'C' }); t.after(C.stop); const D = await startServer({ ...L, instanceId: 'D' }); t.after(D.stop);
  const ok = [...await badLogin(C, 4), ...await badLogin(D, 4)]; assert.ok(ok.every(s => s === 401), 'con límite local 8 intentos pasan entre dos instancias: ' + ok);
  assert.equal((await badLogin(C))[0], 429);
});

test('atomicidad: 60 intentos simultáneos repartidos entre 2 instancias dejan pasar EXACTAMENTE el máximo', { skip: redisSkip, timeout: 60000 }, async t => {
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const common = { redisUrl: `redis://127.0.0.1:${port}`, redisPrefix: 'at:', loginPerMin: 10, loginGlobalFailPerMin: 1000 };
  const A = await startServer({ ...common, instanceId: 'A' }); t.after(A.stop); const B = await startServer({ ...common, instanceId: 'B' }); t.after(B.stop);
  const res = await Promise.all(Array.from({ length: 60 }, (_, i) => http((i % 2 ? A : B).base, 'POST', '/api/master/login', { body: { password: 'mal' } }).then(r => r.status)));
  assert.equal(res.filter(s => s === 401).length, 10, 'exactamente 10 llegan a comprobar la contraseña: ' + res.filter(s => s === 401).length);
  assert.equal(res.filter(s => s === 429).length, 50);
});

test('Redis caído: el servicio sigue respondiendo (sin 5xx), los límites siguen vigentes en local, se registra la degradación y al volver Redis se reanuda', { skip: redisSkip, timeout: 90000 }, async t => {
  const port = await freePort(); let redis = await startRedis(port); t.after(() => redis.kill());
  const A = await startServer({ redisUrl: `redis://127.0.0.1:${port}`, redisPrefix: 'dn:', loginPerMin: 3, loginGlobalFailPerMin: 1000, instanceId: 'A', logLevel: 'warn' }); t.after(A.stop);
  assert.deepEqual(await badLogin(A, 1), [401]);
  redis.kill(); await sleep(400);
  const during = []; for (let i = 0; i < 4; i++) during.push((await badLogin(A))[0]);
  assert.ok(during.every(s => s === 401 || s === 429), 'solo 401/429, nunca 5xx ni bloqueos: ' + during);
  assert.ok(during.includes(429), 'el límite SIGUE vigente con Redis caído (respaldo local)');
  assert.equal((await http(A.base, 'GET', '/healthz')).status, 200);
  assert.ok(A.app.metrics.get('ratelimit_backend_errors') >= 1, 'se cuenta el fallo del respaldo');
  assert.ok(A.logs.some(l => l.includes('ratelimit_backend_degraded')), 'y se registra');
  redis = await startRedis(port); t.after(() => redis.kill());
  await sleep(6500);                                                             // pasa el disyuntor (5 s) y ioredis reconecta
  const after = await badLogin(A); assert.ok([401, 429].includes(after[0]));
});

test('revocación compartida: el cierre de sesión en una instancia invalida el token en las demás tras la sincronización; «all» y las instancias nuevas también', { skip: redisSkip, timeout: 60000 }, async t => {
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const common = { redisUrl: `redis://127.0.0.1:${port}`, redisPrefix: 'rv:' };
  const A = await startServer({ ...common, instanceId: 'A' }); t.after(A.stop); const B = await startServer({ ...common, instanceId: 'B' }); t.after(B.stop);
  const t1 = await login(A.base); const t2 = await login(A.base);
  assert.equal((await http(B.base, 'GET', '/api/sessions', { token: t1 })).status, 200, 'el token de A vale en B (mismo secreto)');
  await http(A.base, 'POST', '/api/master/logout', { token: t1, body: {} });
  assert.equal((await http(A.base, 'GET', '/api/sessions', { token: t1 })).status, 401, 'inmediato en la instancia que cerró');
  await B.app.refreshSecurityState();                                            // lo que hace el sondeo cada 5 s
  assert.equal((await http(B.base, 'GET', '/api/sessions', { token: t1 })).status, 401, 'en B tras sincronizar');
  assert.equal((await http(B.base, 'GET', '/api/sessions', { token: t2 })).status, 200, 'el otro token sigue valiendo');
  await http(B.base, 'POST', '/api/master/logout', { token: t2, body: { all: true } });
  const t3 = await login(A.base); await A.app.refreshSecurityState();
  assert.equal((await http(A.base, 'GET', '/api/sessions', { token: t3 })).status, 200, 'uno posterior a «all» vale');
  const C = await startServer({ ...common, instanceId: 'C' }); t.after(C.stop);   // una instancia que arranca DESPUÉS carga las revocaciones
  assert.equal((await http(C.base, 'GET', '/api/sessions', { token: t1 })).status, 401); assert.equal((await http(C.base, 'GET', '/api/sessions', { token: t2 })).status, 401);
  assert.equal((await http(C.base, 'GET', '/api/sessions', { token: t3 })).status, 200);
  const rc = quiet(new Redis(`redis://127.0.0.1:${port}`)); t.after(() => rc.disconnect()); const keys = await rc.zrange('rv:revoked', 0, -1); assert.equal(keys.length, 2, 'solo los dos jti revocados, con vencimiento propio');
});

test('Redis como frontera de confianza: mensajes basura en el canal no llegan a los teléfonos ni rompen el hub; un registro de sesión corrupto equivale a «no existe»', { skip: redisSkip, timeout: 60000 }, async t => {
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const A = await startServer({ redisUrl: `redis://127.0.0.1:${port}`, redisPrefix: 'bz:', instanceId: 'A', logLevel: 'warn' }); t.after(A.stop);
  const op = await login(A.base); const s = await createSession(A.base, op);
  const master = await joinMaster(A.wsUrl, s.sessionId, s.masterToken); const phone = await joinPublic(A.wsUrl, s.sessionId, dev(1));
  const raw = quiet(new Redis(`redis://127.0.0.1:${port}`)); t.after(() => raw.disconnect());
  const junk = ['no es json', '{}', '[]', 'null', '{"k":"state"}', '{"k":"state","s":{}}', '{"k":"state","s":{"stateVersion":"9","commandId":"x","executeAt":1,"serverTimestamp":1,"payload":{"effect":"solid"}}}',
    '{"k":"state","s":{"stateVersion":99,"commandId":"x","executeAt":1,"serverTimestamp":1,"payload":"rojo"}}', '{"k":"otro","s":{}}', '"x"'];
  for (const j of junk) await raw.publish(`bz:ch:${s.sessionId}`, j);
  await sleep(300);
  assert.ok(!phone.msgs.some(m => m.type === 'state' && m.stateVersion === 99), 'ningún estado inventado llegó al teléfono');
  master.send({ protocolVersion: 1, type: 'command', payload: { effect: 'solid', color: '#34C759' } });
  assert.equal((await phone.waitFor('state')).payload.color, '#34C759', 'y una orden real sigue entregándose');
  assert.ok(A.logs.some(l => l.includes('redis_bus_message_invalid')), 'se registra (una vez por periodo, sin volcar el contenido)');
  assert.ok(!A.logs.join('').includes('no es json'), 'el contenido basura no se vuelca a los logs');
  // registro corrupto: la sesión deja de existir para el hub, sin excepciones
  await raw.hset(`bz:s:${s.sessionId}`, 'state', '{esto no es json');
  const c = await new Client(A.wsUrl).open(); c.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: s.sessionId, deviceId: dev(2) });
  const err = await c.waitFor('error'); assert.equal(err.code, 'SESSION_NOT_FOUND');
  assert.ok(A.logs.some(l => l.includes('redis_session_record_invalid')));
  // la forma que se exige coincide con la que produce el sistema
  assert.equal(isBusMessage({ k: 'state', s: { commandId: 'init', stateVersion: 0, executeAt: 0, serverTimestamp: 1, incarnation: 1, payload: { effect: 'off' } } }), true);
});

test('con Redis real un hello a una sesión inexistente NO se suscribe al canal (sin amplificación hacia Redis) y una sesión real sí', { skip: redisSkip, timeout: 60000 }, async t => {
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const A = await startServer({ redisUrl: `redis://127.0.0.1:${port}`, redisPrefix: 'sb:', instanceId: 'A', badJoinPerMinPerIp: 1000 }); t.after(A.stop);
  const probe = quiet(new Redis(`redis://127.0.0.1:${port}`)); t.after(() => probe.disconnect());
  const calls = async name => { const m = (await probe.info('commandstats')).match(new RegExp(`cmdstat_${name}:calls=(\\d+)`)); return m ? Number(m[1]) : 0; };
  const s0 = await calls('subscribe'); const u0 = await calls('unsubscribe');
  for (let i = 0; i < 25; i++) { const c = await new Client(A.wsUrl).open(); c.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: fakeCode(300 + i) }); await c.waitClose(); }
  assert.equal(await calls('subscribe'), s0, '25 hellos inventados: cero suscripciones nuevas'); assert.equal(await calls('unsubscribe'), u0);
  const op = await login(A.base); const s = await createSession(A.base, op); const p = await joinPublic(A.wsUrl, s.sessionId, dev(1));
  assert.ok(p.welcome); assert.equal(await calls('subscribe'), s0 + 1, 'una sesión real sí se suscribe (una vez)');
});
