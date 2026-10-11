'use strict';
// Verificación del propio generador de carga: agregación correcta de varias instancias y reporte fiable del almacenamiento efectivo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleep } = require('./helpers');

const REDIS_BIN = process.env.REDIS_SERVER || '';
const redisSkip = !REDIS_BIN || !fs.existsSync(REDIS_BIN) ? 'REDIS_SERVER no definido: parte Redis omitida (NO verificada)' : false;
const TOOL = path.join(__dirname, '..', 'tools', 'loadtest.js');

function run(argv, env = {}) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), 'lt-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
    execFile(process.execPath, [TOOL, ...argv, '--out', out], { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (!fs.existsSync(out)) return reject(new Error('sin informe: ' + (err && err.message) + ' ' + stderr.slice(0, 400)));
      const r = JSON.parse(fs.readFileSync(out, 'utf8')); fs.unlinkSync(out); resolve({ r, stdout });
    });
  });
}
const quick = ['--spawn', '--clients', '60', '--commands', '2', '--interval', '600', '--lead', '600', '--rate', '200'];

test('generador: 2 instancias reales + Redis => métricas AGREGADAS de ambas (no solo la última) y almacenamiento efectivo = redis', { skip: redisSkip, timeout: 150000 }, async () => {
  const { r } = await run([...quick, '--instances', '2', '--spawn-redis', '--storm', '0.5'], { REDIS_SERVER: REDIS_BIN });
  assert.equal(r.server.processesObserved, 2); assert.equal(r.server.observedAllProcesses, true);
  assert.equal(r.server.effectiveStore, 'redis'); assert.equal(r.server.storeMatchesRequest, true);
  assert.ok(r.server.redisConfigsMasked.every(u => /^redis:\/\/127\.0\.0\.1:\d+$/.test(u)), 'URL enmascarada y sin secretos: ' + r.server.redisConfigsMasked);
  const per = r.server.perInstance;
  // los 60 clientes se repartieron entre las 2 instancias: cada una vio solo su parte y el total coincide
  assert.equal(per.length, 2);
  assert.ok(per.every(p => p.publicNow > 0), 'ambas instancias tienen conexiones');
  assert.equal(per.reduce((n, p) => n + p.peaks.connections, 0) >= 60, true);
  // los contadores agregados son EXACTAMENTE la suma de los acumulados por instancia (cada una contada una sola vez)
  for (const k of ['ws_connections_total', 'messages_out', 'bytes_out', 'commands_accepted']) {
    const sum = per.reduce((n, p) => n + (r.server.perInstance.find(x => x.instance === p.instance).counters[k] || 0), 0);
    assert.equal(r.server.counters[k], sum, `contador ${k}: agregado == suma por instancia`);
  }
  assert.ok(r.server.counters.ws_connections_total >= 60 + 30, 'conexiones iniciales + reconexiones del corte masivo, de AMBAS instancias');
  // la ventana de órdenes usa deltas por instancia: mensajes ≈ clientes × órdenes (60 × 2), no el acumulado total
  assert.ok(r.commands.serverMessagesOutDeltaAggregated >= 120 && r.commands.serverMessagesOutDeltaAggregated < 400, 'delta agregado: ' + r.commands.serverMessagesOutDeltaAggregated);
  assert.equal(r.commands.lossPct, 0); assert.equal(r.commands.lost, 0);
  assert.equal(r.commands.totalDelivered, 120);
  assert.equal(r.connections.attempted, 60); assert.equal(r.connections.established, 60);
  assert.equal(r.storm.dropped, 30); assert.equal(r.storm.recovered, 30);
  assert.ok(r.server.latencyMergedFromBuckets.broadcastMs.n >= 2 * 2, 'histograma combinado por buckets de ambas instancias');
  assert.ok(r.generator.eventLoopLagP99Ms >= 0 && 'saturated' in r.generator, 'se informa la salud del generador');
  assert.ok(Array.isArray(r.verdict.failed) && r.verdict.criteria['3 pérdida <= 0,1 %'] === true);
  assert.ok(r.durationS > 0 && r.params.INSTANCES === 2);
});

test('generador: un REDIS_URL heredado del shell NO activa Redis a escondidas; el informe dice "memory"', { timeout: 150000 }, async () => {
  const { r } = await run(quick, { REDIS_URL: 'redis://:no-debe-usarse@127.0.0.1:9', CLUSTER_WORKERS: '3' });
  assert.equal(r.server.effectiveStore, 'memory');
  assert.equal(r.server.redisRequestedByFlags, false); assert.equal(r.server.storeMatchesRequest, true);
  assert.equal(r.server.processesObserved, 1, 'CLUSTER_WORKERS heredado tampoco se aplica');
  assert.ok(!JSON.stringify(r).includes('no-debe-usarse'));
  assert.equal(r.connections.established, 60);
});

test('generador: si el almacenamiento efectivo NO coincide con lo pedido por argumentos, el informe lo marca', { skip: redisSkip, timeout: 150000 }, async () => {
  const port = await new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const redis = spawn(REDIS_BIN, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  try {
    await sleep(1200);
    const { r } = await run([...quick, '--env', `REDIS_URL=redis://127.0.0.1:${port}`]);          // Redis activado por otra vía (no por --redis)
    assert.equal(r.server.effectiveStore, 'redis');
    assert.equal(r.server.redisRequestedByFlags, false);
    assert.equal(r.server.storeMatchesRequest, false);
    assert.ok(r.verdict.caveats.some(c => /NO coincide/.test(c)));
  } finally { redis.kill(); }
});
