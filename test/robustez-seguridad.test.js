'use strict';
// Robustez de la capa WebSocket/HTTP y del cliente frente a entradas hostiles (V3.5.0): mensajes fragmentados, contaminación de prototipos, JSON profundo,
// confusión de roles, reflejo de identificadores, errores internos sin detalles, aislamiento entre entornos de Redis y ausencia de sinks de HTML en el cliente.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const nodeHttp = require('http');
const { startServer, http, login, createSession, joinPublic, joinMaster, Client, sleep, dev } = require('./helpers');

const REDIS_BIN = process.env.REDIS_SERVER || '';
const redisSkip = !REDIS_BIN || !fs.existsSync(REDIS_BIN) ? 'REDIS_SERVER no definido: parte Redis omitida (NO verificada)' : false;
const PUBLIC = path.join(__dirname, '..', 'public');

test('mensajes fragmentados: se reensamblan y respetan el límite de tamaño (un hello legítimo en 2 trozos funciona; 3 trozos que suman más del máximo cierran con 1009)', async t => {
  const srv = await startServer({ maxMessageBytes: 2048 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const ok = await new Client(srv.wsUrl).open(); const hello = JSON.stringify({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: s.sessionId, deviceId: dev(1) });
  ok.ws.send(hello.slice(0, 20), { fin: false }); ok.ws.send(hello.slice(20), { fin: true });
  assert.ok((await ok.waitFor('welcome')).sessionId === s.sessionId, 'un mensaje fragmentado y pequeño se procesa');
  const big = await new Client(srv.wsUrl).open();
  for (const fin of [false, false, true]) big.ws.send(Buffer.alloc(1000, 65).toString(), { fin });
  const closed = await big.waitClose(4000); assert.equal(closed.code, 1009, 'mensaje demasiado grande aunque llegue en trozos de 1 000 bytes');
  const same = await new Client(srv.wsUrl).open(); same.ws.send('x'.repeat(5000)); assert.equal((await same.waitClose(4000)).code, 1009);
  assert.equal((await http(srv.base, 'GET', '/healthz')).status, 200, 'el servidor sigue sano');
});

test('contaminación de prototipos y JSON hostil: __proto__/constructor/prototype se rechazan como campos desconocidos; un JSON anidado al máximo no cuelga ni rompe el servidor', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const op = await login(srv.base); const s = await createSession(srv.base, op); const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const sendRaw = async (c, text) => { c.ws.send(text); return c.waitFor(m => m.type === 'error', 3000, 'error'); };
  for (const evil of ['{"type":"command","payload":{"__proto__":{"polluted":true},"effect":"solid","color":"#FF0000"}}', '{"type":"command","__proto__":{"polluted":true},"payload":{"effect":"off"}}',
    '{"type":"command","payload":{"effect":"solid","color":"#FF0000","constructor":{"prototype":{"polluted":true}}}}', '{"type":"command","payload":{"effect":"solid","color":"#FF0000","prototype":1}}']) {
    const e = await sendRaw(master, evil); assert.equal(e.code, 'UNKNOWN_FIELD', evil.slice(0, 60));
  }
  const anon = await new Client(srv.wsUrl).open(); const e2 = await sendRaw(anon, '{"type":"hello","__proto__":{"polluted":true},"role":"public","sessionId":"' + s.sessionId + '"}'); assert.equal(e2.code, 'UNKNOWN_FIELD');
  assert.equal(({}).polluted, undefined, 'Object.prototype no se contaminó'); assert.equal(Object.prototype.polluted, undefined);
  const deep = new Client(srv.wsUrl); await deep.open(); deep.ws.send('['.repeat(1000) + ']'.repeat(1000));
  assert.equal((await deep.waitFor(m => m.type === 'error', 3000)).code, 'INVALID_MESSAGE');
  await sleep(1100);                                                          // los errores sin commandId se limitan a 1 por segundo y conexión
  deep.ws.send('{"a":'.repeat(300) + '1' + '}'.repeat(300)); assert.equal((await deep.waitFor(m => m.type === 'error', 3000)).code, 'UNKNOWN_TYPE');
  const t0 = Date.now(); await http(srv.base, 'GET', '/healthz'); assert.ok(Date.now() - t0 < 500, 'el servidor responde con normalidad después');
});

test('roles: un participante no ejecuta acciones de Master; un token de operador, de otra sesión o inventado no abre un Master; un participante no puede enviar token', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const op = await login(srv.base); const s1 = await createSession(srv.base, op); const s2 = await createSession(srv.base, op);
  let n = 0;
  for (const body of [{ type: 'command', commandId: 'cmd-00000001', payload: { effect: 'solid', color: '#FF0000' } }, { type: 'stop', commandId: 'cmd-00000002' }, { type: 'setConfig', strobeEnabled: false }]) {
    const p = await joinPublic(srv.wsUrl, s1.sessionId, dev(++n));            // un teléfono por mensaje: los errores sin commandId se limitan a 1 por segundo y conexión
    p.send({ protocolVersion: 1, ...body }); assert.equal((await p.waitFor('error')).code, 'FORBIDDEN', body.type);
  }
  const tryMaster = async (sessionId, token) => { const c = await new Client(srv.wsUrl).open(); c.send({ protocolVersion: 1, type: 'hello', role: 'master', sessionId, token }); const e = await c.waitFor('error'); assert.equal((await c.waitClose()).code, 4401); return e.code; };
  assert.equal(await tryMaster(s1.sessionId, op), 'UNAUTHORIZED', 'token de OPERADOR como Master');
  assert.equal(await tryMaster(s1.sessionId, s2.masterToken), 'UNAUTHORIZED', 'token de Master de OTRA sesión');
  assert.equal(await tryMaster(s1.sessionId, 'a'.repeat(40) + '.' + 'b'.repeat(43)), 'UNAUTHORIZED', 'token inventado');
  const withToken = await new Client(srv.wsUrl).open(); withToken.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: s1.sessionId, token: s1.masterToken });
  assert.equal((await withToken.waitFor('error')).code, 'INVALID_FIELD', 'un participante no puede presentar token');
  const m = await joinMaster(srv.wsUrl, s1.sessionId, s1.masterToken); m.send({ protocolVersion: 1, type: 'command', payload: { effect: 'solid', color: '#00FF00' } }); assert.ok((await m.waitFor('ack')).stateVersion >= 1, 'el Master legítimo sí');
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: s1.masterToken })).status, 401, 'y su token tampoco sirve en la API de operador');
});

test('x-request-id: solo se refleja con formato válido (si no, se genera uno); las respuestas de error no revelan detalles internos', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const hit = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => { const r = nodeHttp.request({ host: '127.0.0.1', port: srv.port, path, method, headers }, res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); }); r.on('error', reject); r.end(); });
  assert.equal((await hit('/healthz', { 'x-request-id': 'req_ABC-123456' })).headers['x-request-id'], 'req_ABC-123456');
  for (const bad of ['corto', '<script>alert(1)</script>', 'a'.repeat(200), '../../etc/passwd', 'id con espacios', 'ñandú-ñandú']) {
    const got = (await hit('/healthz', { 'x-request-id': bad })).headers['x-request-id']; assert.match(got, /^[0-9a-f]{12}$/, 'se descarta y se genera: ' + bad.slice(0, 20));
  }
  for (const [p, m] of [['/api/nada', 'GET'], ['/api/sessions', 'PUT'], ['/%E0%A4%A', 'GET'], ['/api/sessions/AAAAAA/otra', 'GET']]) {
    const r = await hit(p, {}, m); assert.ok([400, 401, 404].includes(r.status), p + ' -> ' + r.status); assert.ok(!/stack|at \w+ \(|node_modules|src[\\/]/.test(r.body), 'sin trazas ni rutas: ' + r.body.slice(0, 80));
  }
});

test('un fallo interno del almacenamiento en la API responde SERVER_ERROR genérico (sin mensaje ni traza) y el detalle queda solo en el log', async t => {
  const { createMemoryStore } = require('../src/store/memory');
  const base = createMemoryStore({ sessionTtlS: 60, maxCommandHistory: 50, presenceTtlMs: 1000 });
  const store = Object.assign(Object.create(base), { listSessions: async () => { throw new Error('SECRETO-INTERNO conexión a 10.0.0.5:6379 rechazada'); } });
  const srv = await startServer({}, { store }); t.after(srv.stop);
  const r = await http(srv.base, 'GET', '/api/sessions', { token: await login(srv.base) });
  assert.equal(r.status, 500); assert.deepEqual(r.json, { error: 'SERVER_ERROR' }); assert.ok(!r.text.includes('SECRETO-INTERNO') && !r.text.includes('10.0.0.5'));
  assert.ok(srv.logs.some(l => l.includes('SECRETO-INTERNO')), 'el detalle sí queda en el log (para investigar)');
  assert.equal((await http(srv.base, 'GET', '/healthz')).status, 200);
});

test('cliente: el código propio no usa sinks de HTML ni de ejecución dinámica (innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, new Function, setTimeout con texto) ni atributos de evento en línea', () => {
  const files = ['master.html', 'index.html', 'flash.html', 'flash-disabled.html', 'colores.html', ...fs.readdirSync(path.join(PUBLIC, 'js')).filter(f => f !== 'qrcode.js').map(f => 'js/' + f)];
  const re = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(|setTimeout\(\s*['"`]|setInterval\(\s*['"`]|\.srcdoc\s*=/; const hits = [];
  for (const f of files) fs.readFileSync(path.join(PUBLIC, f), 'utf8').split('\n').forEach((l, i) => {
    if (l.length > 1500 || /^\s*(\/\/|\*|\/\*|<!--)/.test(l)) return;               // se omiten comentarios y la biblioteca de QR minificada incrustada en flash.html
    if (re.test(l.replace(/\/\/.*$/, ''))) hits.push(`${f}:${i + 1}`);
    if (f.endsWith('.html') && /\son[a-z]+\s*=\s*["']/i.test(l)) hits.push(`${f}:${i + 1} (atributo de evento)`);
  });
  assert.deepEqual(hits, [], 'sinks inseguros en código propio: ' + hits.join(', '));
  assert.ok(files.length >= 12);
  // el texto dinámico del panel se escribe con textContent (lo declara y lo cumple)
  assert.match(fs.readFileSync(path.join(PUBLIC, 'js/master.js'), 'utf8'), /textContent/);
});

function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
test('aislamiento entre entornos de Redis: con REDIS_PREFIX distinto, un entorno no ve las sesiones del otro y su token de Master no abre nada', { skip: redisSkip, timeout: 60000 }, async t => {
  const port = await freePort(); const redis = spawn(REDIS_BIN, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }); t.after(() => redis.kill());
  for (let i = 0; i < 50; i++) { if (await new Promise(r => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); })) break; await sleep(100); }
  const url = `redis://127.0.0.1:${port}`;
  const prod = await startServer({ redisUrl: url, redisPrefix: 'prod:', instanceId: 'P' }); t.after(prod.stop); const stg = await startServer({ redisUrl: url, redisPrefix: 'stg:', instanceId: 'S' }); t.after(stg.stop);
  const sp = await createSession(prod.base, await login(prod.base));
  assert.deepEqual((await http(stg.base, 'GET', '/api/sessions', { token: await login(stg.base) })).json.sessions, [], 'staging no lista las sesiones de producción');
  const c = await new Client(stg.wsUrl).open(); c.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: sp.sessionId, deviceId: dev(1) }); assert.equal((await c.waitFor('error')).code, 'SESSION_NOT_FOUND');
  const m = await new Client(stg.wsUrl).open(); m.send({ protocolVersion: 1, type: 'hello', role: 'master', sessionId: sp.sessionId, token: sp.masterToken }); assert.equal((await m.waitFor('error')).code, 'SESSION_NOT_FOUND');
  const ok = await joinPublic(prod.wsUrl, sp.sessionId, dev(2)); assert.ok(ok.welcome, 'y producción sigue funcionando');
});

test('plantilla Lua de Redis: ningún identificador aceptado por el protocolo puede reproducir los marcadores que se sustituyen (defensa en profundidad fijada con una prueba)', () => {
  const P = require('../src/protocol');
  for (const marker of ['__V__', '__I__']) assert.ok(!P.COMMAND_ID_RE.test(marker), 'el marcador no es un commandId válido: ' + marker);
  const ids = ['cmd-12345678', 'A'.repeat(64), '_'.repeat(64), '__V__' + 'x'.repeat(10), 'x'.repeat(10) + '__I__'];
  for (const id of ids) {
    if (!P.COMMAND_ID_RE.test(id)) continue;
    const tpl = JSON.stringify({ commandId: id, stateVersion: '__V__', serverTimestamp: 1, executeAt: 2, incarnation: '__I__', payload: { effect: 'solid', color: '#FF0000', color2: '#000000', intensity: 1, fadeMs: 0 } });
    assert.equal(tpl.split('"__V__"').length - 1, 1, 'un solo marcador de versión con el id ' + id.slice(0, 12)); assert.equal(tpl.split('"__I__"').length - 1, 1, 'un solo marcador de incarnation');
  }
  assert.ok(!P.COMMAND_ID_RE.test('a"b-12345678') && !P.COMMAND_ID_RE.test('a b-12345678'), 'las comillas y espacios no entran en un commandId');
});
