'use strict';
// Limitador compartido (V3.5.0): ventana, atomicidad bajo concurrencia, aislamiento por clave, respaldo local ante fallos del almacenamiento (sin caída),
// disyuntor, demoras del almacenamiento y normalización de IP. La parte con Redis REAL y varias instancias está en limitador-redis.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SharedLimiter, KeyedLimiter, TokenBucket } = require('../src/ratelimit');
const { createMemoryStore } = require('../src/store/memory');
const { createMetrics } = require('../src/metrics');
const { normalizeIp } = require('../src/app');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const memStore = () => createMemoryStore({ sessionTtlS: 60, maxCommandHistory: 50, presenceTtlMs: 1000 });
function logSpy() { const lines = []; return { lines, warn: (m, f) => lines.push(['warn', m, f]), info() {}, error() {}, debug() {} }; }

test('ventana fija: deja pasar exactamente `max` golpes, bloquea el siguiente y vuelve a permitir al vencer la ventana', async () => {
  const L = new SharedLimiter({ name: 't1', max: 3, windowMs: 250, store: memStore() });
  const r = []; for (let i = 0; i < 5; i++) r.push(await L.hit('ip'));
  assert.deepEqual(r, [true, true, true, false, false]);
  assert.equal(await L.peek('ip'), false, 'peek: ya alcanzó el límite');
  await sleep(300);
  assert.equal(await L.peek('ip'), true, 'tras la ventana vuelve a haber cupo');
  assert.equal(await L.hit('ip'), true);
});

test('peek no cuenta; las claves y los limitadores con distinto nombre están aislados', async () => {
  const st = memStore(); const A = new SharedLimiter({ name: 'a', max: 2, store: st }); const B = new SharedLimiter({ name: 'b', max: 2, store: st });
  for (let i = 0; i < 10; i++) assert.equal(await A.peek('x'), true);
  assert.equal(await A.hit('x'), true); assert.equal(await A.hit('x'), true); assert.equal(await A.hit('x'), false);
  assert.equal(await A.hit('y'), true, 'otra clave (otra IP) no se ve afectada');
  assert.equal(await B.hit('x'), true, 'otro limitador con la misma clave tampoco');
});

test('concurrencia: 500 golpes simultáneos sobre la misma clave dejan pasar EXACTAMENTE el máximo (sin condiciones de carrera)', async () => {
  const L = new SharedLimiter({ name: 'c', max: 37, store: memStore() });
  const res = await Promise.all(Array.from({ length: 500 }, () => L.hit('misma-ip')));
  assert.equal(res.filter(Boolean).length, 37); assert.equal(res.filter(r => !r).length, 463);
});

test('sin almacenamiento funciona en local; ante un ERROR del almacenamiento mantiene el límite en local, no lanza y lo registra una sola vez', async () => {
  assert.equal(await new SharedLimiter({ name: 'l', max: 1 }).hit('k'), true);
  let calls = 0; const store = { rateHit: async () => { calls++; throw new Error('ECONNREFUSED 10.0.0.9:6379'); }, rateCount: async () => { throw new Error('caído'); } };
  const metrics = createMetrics(); const logger = logSpy();
  const L = new SharedLimiter({ name: 'down', max: 3, store, metrics, logger, breakerMs: 10000 });
  const r = []; for (let i = 0; i < 6; i++) r.push(await L.hit('ip'));
  assert.deepEqual(r, [true, true, true, false, false, false], 'el límite SIGUE vigente (respaldo local), no se «abre» ni se rompe');
  assert.equal(await L.peek('ip'), false);
  assert.equal(calls, 1, 'disyuntor abierto: no se vuelve a llamar al almacenamiento mientras dure (sin acumular peticiones colgadas)');
  assert.equal(L.degraded, true); assert.ok(metrics.get('ratelimit_backend_errors') >= 1);
  assert.equal(logger.lines.filter(l => l[1] === 'ratelimit_backend_degraded').length, 1, 'un solo aviso por periodo');
  metrics.stop();
});

test('disyuntor: pasado el tiempo se reintenta el almacenamiento y, si volvió, se usa de nuevo (el límite vuelve a ser compartido)', async () => {
  let t = 1_000_000; let healthy = false; const st = memStore(); let calls = 0;
  const store = { rateHit: async (k, w) => { calls++; if (!healthy) throw new Error('caído'); return st.rateHit(k, w); }, rateCount: async k => st.rateCount(k) };
  const L = new SharedLimiter({ name: 'br', max: 2, store, breakerMs: 5000, now: () => t });
  assert.equal(await L.hit('k'), true); assert.equal(calls, 1); assert.equal(L.degraded, true);
  t += 6000; healthy = true;
  assert.equal(L.degraded, false); await L.hit('k2'); assert.equal(calls, 2, 'tras el disyuntor se vuelve a consultar el almacenamiento');
  assert.equal(L.degraded, false);
});

test('demora del almacenamiento: no bloquea la petición más que `timeoutMs` y cae al contador local', async () => {
  const store = { rateHit: () => new Promise(() => {}), rateCount: () => new Promise(() => {}) };     // no responde nunca
  const L = new SharedLimiter({ name: 'slow', max: 2, store, timeoutMs: 60, breakerMs: 10000 });
  const t0 = Date.now(); const a = await L.hit('ip'); const dt = Date.now() - t0;
  assert.equal(a, true); assert.ok(dt >= 50 && dt < 400, `respondió por tiempo en ${dt} ms`);
  const t1 = Date.now(); await L.hit('ip'); assert.ok(Date.now() - t1 < 30, 'con el disyuntor abierto ya no espera');
  assert.equal(await L.hit('ip'), false, 'el límite local sigue vigente (3.er golpe con máximo 2)');
});

test('KeyedLimiter y TokenBucket conservan su comportamiento (ventana por clave y cupo por conexión)', () => {
  const k = new KeyedLimiter(2); assert.deepEqual([k.hit('a'), k.hit('a'), k.hit('a'), k.hit('b')], [true, true, false, true]); assert.equal(k.peek('a'), false); assert.equal(k.peek('z'), true);
  let t = 0; const b = new TokenBucket(2, 4, () => t); assert.deepEqual([b.take(), b.take(), b.take(), b.take(), b.take()], [true, true, true, true, false]);
  t += 1000; assert.equal(b.take(), true, 'a 2 por segundo se repone cupo');
});

test('normalizeIp: IPv4 tal cual, IPv4 mapeada como IPv4, IPv6 agrupada por /64 (rotar direcciones del mismo abonado no evita el límite), basura → null', () => {
  assert.equal(normalizeIp('203.0.113.7'), '203.0.113.7'); assert.equal(normalizeIp('::ffff:203.0.113.7'), '203.0.113.7'); assert.equal(normalizeIp(' 203.0.113.7 '), '203.0.113.7');
  const a = normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd'); const b = normalizeIp('2001:DB8:1:2::1'); const c = normalizeIp('2001:db8:1:3::1');
  assert.equal(a, '2001:db8:1:2::/64'); assert.equal(a, b, 'mismo /64 → misma clave'); assert.notEqual(a, c, 'otro /64 → otra clave');
  assert.equal(normalizeIp('::1'), '0:0:0:0::/64'); assert.equal(normalizeIp('fe80::1%eth0'), 'fe80:0:0:0::/64', 'se ignora el identificador de zona');
  for (const bad of ['', null, undefined, 'abc', '999.1.1.1', '1.2.3', '2001:db8::zz', 'x'.repeat(100), '1.2.3.4, 5.6.7.8', '<script>']) assert.equal(normalizeIp(bad), null, String(bad).slice(0, 20));
});
