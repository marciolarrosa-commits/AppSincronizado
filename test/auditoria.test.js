'use strict';
// Pruebas de la auditoría V3.1: límites por capas (NAT), Host/XSS, fugas de recursos, incarnation y configuración verificable.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const { loadConfig } = require('../src/config');
const { startServer, login, createSession, joinPublic, joinMaster, joinMany, sleep, dev, Client, http: req } = require('./helpers');
const { http: httpJson } = require('./helpers');

const REDIS_BIN = process.env.REDIS_SERVER || '';
const redisSkip = !REDIS_BIN || !fs.existsSync(REDIS_BIN) ? 'REDIS_SERVER no definido: parte Redis omitida (NO verificada)' : false;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const fakeCode = i => 'Q' + [4, 3, 2, 1, 0].map(k => ALPHA[Math.floor(i / 32 ** k) % 32]).join('');
function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
async function startRedis(port, extra = []) {
  const p = spawn(REDIS_BIN, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', ...extra], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await new Promise(r => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); })) return p;
    await sleep(100);
  }
  throw new Error('redis no arrancó');
}

test('valores por defecto de los límites por IP: justificados para NAT de operadoras/estadio', () => {
  const c = loadConfig({ NODE_ENV: 'development' });
  assert.equal(c.wsConnectPerMinPerIp, 60000, 'una IP NAT con 60 000 teléfonos uniéndose en 1 min no debe ser cortada');
  assert.equal(c.preHelloMaxPerIp, 1000);
  assert.equal(c.maxConnPerIp, 0, 'sin tope de conexiones totales por IP por defecto (un NAT de estadio puede tener decenas de miles)');
  assert.equal(c.badJoinPerMinPerIp, 120);
  assert.equal(c.clockPingIntervalMs, 30000);
});

test('NAT: 3 500 teléfonos desde UNA misma IP se unen en segundos sin falsos positivos (el límite anterior de 3 000/min habría cortado a ~500)', { timeout: 120000 }, async t => {
  const srv = await startServer({ wsConnectPerMinPerIp: loadConfig({}).wsConnectPerMinPerIp, badJoinPerMinPerIp: loadConfig({}).badJoinPerMinPerIp, preHelloMaxPerIp: loadConfig({}).preHelloMaxPerIp }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const t0 = Date.now();
  const phones = await joinMany(srv.wsUrl, s.sessionId, 3500, {}, 100);
  assert.equal(phones.length, 3500);
  assert.equal(srv.app.hub.stats().public, 3500);
  assert.equal(srv.app.metrics.get('ws_rejected_rate'), 0);
  assert.equal(srv.app.metrics.get('ws_rejected_prehello'), 0);
  console.log(`# 3 500 uniones desde una IP en ${Date.now() - t0} ms`);
  for (const p of phones) p.terminate();
});

test('capa 2: conexiones sin hello simultáneas por IP; un cliente que completa el hello deja de contar', async t => {
  const srv = await startServer({ preHelloMaxPerIp: 3, helloTimeoutMs: 4000 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const idle = []; for (let i = 0; i < 3; i++) idle.push(await new Client(srv.wsUrl).open());
  await assert.rejects(new Client(srv.wsUrl).open(), e => e.status === 429, 'la 4.ª conexión sin hello se rechaza');
  assert.equal(srv.app.metrics.get('ws_rejected_prehello'), 1);
  idle[0].send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: s.sessionId, deviceId: dev(1) });   // completa el hello -> libera un cupo
  await idle[0].waitFor('welcome');
  const ok = await new Client(srv.wsUrl).open(); assert.ok(ok);
  for (const c of [...idle, ok]) c.terminate();
});

test('capa 5: tope opcional de conexiones totales por IP', async t => {
  const srv = await startServer({ maxConnPerIp: 4 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const ph = await joinMany(srv.wsUrl, s.sessionId, 4);
  await assert.rejects(new Client(srv.wsUrl).open(), e => e.status === 429);
  assert.equal(srv.app.metrics.get('ws_rejected_ipcap'), 1);
  ph[0].terminate(); await sleep(150);
  assert.ok(await new Client(srv.wsUrl).open());
});

test('capa 3: fallos por IP — 119 códigos mal escritos NO bloquean; al superar el umbral sí (y se ve en las métricas)', { timeout: 60000 }, async t => {
  const srv = await startServer({ badJoinPerMinPerIp: 120, wsConnectPerMinPerIp: 100000 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  for (let i = 0; i < 119; i++) {
    const c = await new Client(srv.wsUrl).open();
    c.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: fakeCode(i) });
    await c.waitClose();
  }
  const good = await joinPublic(srv.wsUrl, s.sessionId, dev(1));          // un participante legítimo con el código correcto sigue entrando
  assert.ok(good.welcome);
  for (let i = 0; i < 3; i++) { const c = await new Client(srv.wsUrl).open().catch(e => e); if (c instanceof Client) { c.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: fakeCode(900 + i) }); await c.waitClose(); } }
  await assert.rejects(new Client(srv.wsUrl).open(), e => e.status === 429);
  assert.ok(srv.app.metrics.get('ws_rejected_badjoin') >= 1);
});

test('Host malicioso no se refleja en la CSP ni en el enlace del QR; X-Forwarded-Proto solo admite http/https', async t => {
  const srv = await startServer({ trustProxyHops: 1 }); t.after(srv.stop);
  const op = await login(srv.base);
  const hit = (path, headers, method = 'GET', body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, path, method, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
  const page = await hit('/master', { host: "evil.example; script-src *; img-src 'self'" });
  assert.ok(!/script-src \*/.test(page.headers['content-security-policy'] || ''), 'el Host con ; no se refleja');
  assert.match(page.headers['content-security-policy'], /ws:\/\/localhost wss:\/\/localhost/, 'se usa un Host seguro de reserva');
  const created = await hit('/api/sessions', { host: 'ok.example:8443', authorization: 'Bearer ' + op, 'content-type': 'application/json', 'x-forwarded-proto': 'javascript:alert(1)//' }, 'POST', '{}');
  assert.equal(created.status, 201);
  const j = JSON.parse(created.body);
  assert.match(j.joinUrl, /^http:\/\/ok\.example:8443\/\?s=[A-Z0-9]{6}&mode=remote$/);
  const https = await hit('/api/sessions', { host: 'ok.example', authorization: 'Bearer ' + op, 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, 'POST', '{}');
  assert.match(JSON.parse(https.body).joinUrl, /^https:\/\/ok\.example\/\?s=/);
});

test('fugas: tras 1 500 ciclos conectar/desconectar en 6 sesiones no quedan salas, temporizadores, buffers ni contadores por IP', { timeout: 120000 }, async t => {
  const srv = await startServer({ wsConnectPerMinPerIp: 1e9, helloTimeoutMs: 800 }); t.after(srv.stop);
  const op = await login(srv.base);
  const sessions = []; for (let i = 0; i < 6; i++) sessions.push(await createSession(srv.base, op));
  const masters = []; for (const s of sessions) masters.push(await joinMaster(srv.wsUrl, s.sessionId, s.masterToken));
  for (let round = 0; round < 15; round++) {
    const batch = [];
    for (let i = 0; i < 100; i++) batch.push(joinPublic(srv.wsUrl, sessions[i % 6].sessionId, dev(round * 100 + i + 1)));
    const phones = await Promise.all(batch);
    masters[round % 6].send({ protocolVersion: 1, type: 'command', payload: { effect: 'solid', color: '#FF3B30' } });
    for (let i = 0; i < phones.length; i++) { if (i % 3 === 0) phones[i].close(); else phones[i].terminate(); }
    // conexiones que nunca envían hello (se limpian por timeout)
    for (let i = 0; i < 5; i++) { const idle = await new Client(srv.wsUrl).open(); idle.terminate(); }
    await sleep(60);
  }
  for (const m of masters) m.terminate();
  await sleep(800);
  const d = srv.app.hub.debugCounts();
  assert.deepEqual({ rooms: d.rooms, connections: d.connections, heartbeatBuckets: d.heartbeatBuckets, needResync: d.needResync, ackBuf: d.ackBuf, ipTracked: d.ipTracked, statsTimers: d.statsTimers },
    { rooms: 0, connections: 0, heartbeatBuckets: 0, needResync: 0, ackBuf: 0, ipTracked: 0, statsTimers: 0 }, 'todas las estructuras internas vuelven a cero');
  assert.equal(srv.app.metrics.snapshot().gauges.connections_total, 0);
});

test('incarnation (memoria): si la sesión se re-crea con el mismo código con el hub vivo, las órdenes nuevas SÍ llegan', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  const m1 = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phone = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  for (let i = 0; i < 3; i++) { m1.send({ protocolVersion: 1, type: 'command', payload: { effect: 'solid', color: '#FF0000' } }); await m1.waitFor('ack'); await phone.waitFor('state'); }
  await srv.app.store.deleteSession(s.sessionId);                                   // la sesión desaparece del almacenamiento (p. ej. caducó)
  await sleep(5);
  const re = await httpJson(srv.base, 'POST', '/api/sessions', { token: op, body: { sessionId: s.sessionId } });
  assert.equal(re.status, 201);
  const m2 = await joinMaster(srv.wsUrl, s.sessionId, re.json.masterToken);
  m2.send({ protocolVersion: 1, type: 'command', payload: { effect: 'solid', color: '#00FF00' } });
  assert.equal((await m2.waitFor('ack')).stateVersion, 1);
  const st = await phone.waitFor('state', 2500, 'orden de la sesión re-creada');
  assert.equal(st.payload.color, '#00FF00'); assert.equal(st.stateVersion, 1);
  assert.equal(srv.app.metrics.get('session_incarnation_changes') >= 1, true);
});

test('Redis: ackRate usa la audiencia GLOBAL en todas las instancias (también en las que no tienen Master)', { skip: redisSkip, timeout: 60000 }, async t => {
  const port = await freePort(); const redis = await startRedis(port); t.after(() => redis.kill());
  const url = `redis://127.0.0.1:${port}`;
  const common = { redisUrl: url, ackTargetPerCommand: 10, presenceIntervalMs: 200, wsConnectPerMinPerIp: 1e9 };
  const A = await startServer({ ...common, instanceId: 'A', redisPrefix: 'ar:' }); t.after(A.stop);
  const B = await startServer({ ...common, instanceId: 'B', redisPrefix: 'ar:' }); t.after(B.stop);
  const op = await login(A.base); const s = await createSession(A.base, op);
  const mA = await joinMaster(A.wsUrl, s.sessionId, s.masterToken);
  const onA = await joinMany(A.wsUrl, s.sessionId, 20, {}, 20, 0);
  const onB = await joinMany(B.wsUrl, s.sessionId, 20, {}, 20, 100);
  await sleep(900);                                                         // la presencia global se propaga
  mA.send({ protocolVersion: 1, type: 'command', payload: { effect: 'solid', color: '#FF3B30' } });
  const stB = await onB[0].waitFor('state'); const stA = await onA[0].waitFor('state');
  assert.equal(stA.ackRate, 0.25, 'audiencia global 40 -> 10/40');
  assert.equal(stB.ackRate, 0.25, 'la instancia B (sin Master) también usa la audiencia global, no solo sus 20 locales (daría 0,5)');
});

test('Redis: la configuración efectiva del almacenamiento se puede verificar SIN exponer la contraseña', { skip: redisSkip, timeout: 60000 }, async t => {
  const port = await freePort(); const redis = await startRedis(port, ['--requirepass', 'sup3r-s3cr3t-pass']); t.after(() => redis.kill());
  const url = `redis://:sup3r-s3cr3t-pass@127.0.0.1:${port}`;
  const A = await startServer({ redisUrl: url, instanceId: 'A', redisPrefix: 'cfg:', logLevel: 'info' }); t.after(A.stop);
  const op = await login(A.base);
  const st = await httpJson(A.base, 'GET', '/api/admin/status', { token: op });
  assert.equal(st.json.store.kind, 'redis'); assert.equal(st.json.store.config.kind, 'redis');
  assert.equal(st.json.store.config.url, `redis://***@127.0.0.1:${port}`);
  const all = JSON.stringify(st.json) + A.logs.join('\n');
  assert.ok(!all.includes('sup3r-s3cr3t-pass'), 'la contraseña de Redis no aparece en la API ni en los logs');
  assert.ok(A.logs.some(l => l.includes('"storeConfig"')), 'el arranque registra la configuración efectiva (enmascarada)');
  const metrics = await httpJson(A.base, 'GET', '/metrics', { token: op });
  assert.ok(!metrics.text.includes('sup3r-s3cr3t-pass'));
});

test('memoria: /api/admin/status informa kind=memory (no se puede confundir con Redis)', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const st = await httpJson(srv.base, 'GET', '/api/admin/status', { token: await login(srv.base) });
  assert.equal(st.json.store.config.kind, 'memory');
  assert.ok(st.json.metrics.latency.broadcastMs.buckets.edges.length > 5, 'se publican los buckets para agregar histogramas de varias instancias');
});

test('NAT: miles de teléfonos desde la misma IP pueden CARGAR la página y sus archivos (límite HTTP solo para la API sensible)', { timeout: 60000 }, async t => {
  const c = loadConfig({});
  const srv = await startServer({ httpPerMin: c.httpPerMin, httpStaticPerMin: c.httpStaticPerMin, loginPerMin: c.loginPerMin }); t.after(srv.stop);
  const paths = ['/', '/js/effects.js', '/js/remote.js', '/favicon.svg'];
  const codes = { 200: 0, other: 0 };
  // 700 teléfonos × 4 archivos = 2 800 peticiones desde una IP en pocos segundos (con el límite anterior de 600/min, 2 200 recibían 429)
  for (let i = 0; i < 700; i += 50) {
    const rs = await Promise.all(Array.from({ length: 50 }, (_, k) => Promise.all(paths.map(p => fetch(srv.base + p, { headers: { 'accept-encoding': 'gzip' } }).then(r => { r.arrayBuffer(); return r.status; })))));
    for (const row of rs) for (const s of row) { if (s === 200) codes[200]++; else codes.other++; }
  }
  assert.equal(codes.other, 0, `peticiones rechazadas: ${codes.other}`);
  assert.equal(codes[200], 2800);
  // la API sensible SÍ sigue limitada por IP
  const op = await login(srv.base);
  let limited = 0; for (let i = 0; i < c.httpPerMin + 20; i++) { const r = await httpJson(srv.base, 'GET', '/api/sessions', { token: op }); if (r.status === 429) { limited++; break; } }
  assert.ok(limited >= 1, 'la API del operador mantiene su límite por IP');
});
