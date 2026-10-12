'use strict';
// Seguridad HTTP/WebSocket (V3.5.0), contra el servidor REAL: login endurecido, cierre de sesión con revocación, peticiones entre sitios, redirección HTTPS,
// origen canónico, salud sin datos internos, límites que no castigan al NAT, IP normalizada (IPv6 /64) y sala no creada para sesiones inexistentes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, http, login, createSession, joinPublic, joinMaster, Client, sleep, dev, PASSWORD } = require('./helpers');

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const fakeCode = i => 'Q' + [4, 3, 2, 1, 0].map(k => ALPHA[Math.floor(i / 32 ** k) % 32]).join('');
// Petición HTTP «cruda» (http.request): permite fijar Host, rutas raras y cualquier cabecera, cosa que fetch no siempre deja
const nodeHttp = require('http');
const raw = (base, method, path, { body, token, headers } = {}) => new Promise((resolve, reject) => {
  const u = new URL(base);
  const req = nodeHttp.request({ host: u.hostname, port: u.port, path, method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, res => {
    let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: { get: k => res.headers[String(k).toLowerCase()] ?? null }, text: d }));
  });
  req.on('error', reject); if (body) req.write(body); req.end();
});

test('login: solo application/json — una petición «simple» entre sitios (text/plain) se rechaza (415) aunque la contraseña sea correcta', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const body = JSON.stringify({ password: PASSWORD });
  for (const ct of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
    const r = await raw(srv.base, 'POST', '/api/master/login', { body, headers: ct ? { 'content-type': ct } : {} });
    assert.equal(r.status, 415, String(ct)); assert.ok(!r.text.includes('operatorToken'), 'no se emite token');
  }
  const ok = await raw(srv.base, 'POST', '/api/master/login', { body, headers: { 'content-type': 'application/json; charset=utf-8' } });
  assert.equal(ok.status, 200); assert.ok(JSON.parse(ok.text).operatorToken);
  const op = await login(srv.base);
  const s = await raw(srv.base, 'POST', '/api/sessions', { token: op, body: '{}', headers: { 'content-type': 'text/plain' } });
  assert.equal(s.status, 415, 'también en el resto de las acciones con cuerpo');
  const mt = await raw(srv.base, 'POST', '/api/sessions/ABCDEF/revoke', { token: op });                    // sin cuerpo: no hace falta Content-Type
  assert.equal(mt.status, 404, 'sin cuerpo no se exige Content-Type (404 = la sesión no existe, no 415)');
});

test('las acciones POST con Sec-Fetch-Site: cross-site se rechazan (403); same-origin y las peticiones sin ese encabezado funcionan', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const post = h => raw(srv.base, 'POST', '/api/master/login', { body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json', ...h } });
  const cross = await post({ 'sec-fetch-site': 'cross-site' }); assert.equal(cross.status, 403); assert.ok(!cross.text.includes('operatorToken'));
  assert.equal((await post({ 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await post({})).status, 200);
  assert.ok(srv.app.metrics.get('cross_site_post_rejected') >= 1);
});

test('login: éxito y fallo duran lo mismo (≥ 250 ms) — sin canal de tiempo que delate si la contraseña era correcta', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const time = async pw => { const t0 = Date.now(); const r = await http(srv.base, 'POST', '/api/master/login', { body: { password: pw } }); return [Date.now() - t0, r.status]; };
  const [okMs, okSt] = await time(PASSWORD); const [badMs, badSt] = await time('incorrecta');
  assert.equal(okSt, 200); assert.equal(badSt, 401);
  assert.ok(okMs >= 240 && badMs >= 240, `ambos esperan el mínimo (ok ${okMs} ms, fallo ${badMs} ms)`);
  assert.ok(Math.abs(okMs - badMs) < 120, `y la diferencia es mínima (${Math.abs(okMs - badMs)} ms)`);
});

test('login distribuido: con muchos fallos entre todas las IP se DEMORA toda respuesta de login (también la correcta) pero nadie queda bloqueado', { timeout: 30000 }, async t => {
  const srv = await startServer({ loginGlobalFailPerMin: 5, loginPerMin: 1000 }); t.after(srv.stop);
  for (let i = 0; i < 5; i++) assert.equal((await http(srv.base, 'POST', '/api/master/login', { body: { password: 'mal' + i } })).status, 401);
  const t0 = Date.now(); const r = await http(srv.base, 'POST', '/api/master/login', { body: { password: PASSWORD } }); const dt = Date.now() - t0;
  assert.equal(r.status, 200, 'el operador legítimo entra');
  assert.ok(dt >= 1600, `con ataque en curso se demora (${dt} ms)`);
  assert.ok(srv.app.metrics.get('login_tarpit') >= 1);
});

test('cierre de sesión: el token usado deja de valer en el servidor DE INMEDIATO; los demás siguen; «all» invalida todos los anteriores y no los nuevos', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const t1 = await login(srv.base); const t2 = await login(srv.base); const t3 = await login(srv.base);
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: t1 })).status, 200);
  assert.equal((await http(srv.base, 'POST', '/api/master/logout', { token: t1, body: {} })).status, 200);
  for (const [m, p] of [['GET', '/api/sessions'], ['GET', '/api/admin/status'], ['GET', '/api/admin/flash'], ['GET', '/metrics'], ['POST', '/api/master/logout']])
    assert.equal((await http(srv.base, m, p, { token: t1 })).status, 401, `${m} ${p} con el token cerrado`);
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: t2 })).status, 200, 'otro token de operador sigue valiendo');
  assert.equal((await http(srv.base, 'POST', '/api/master/logout', { token: t2, body: { all: true } })).json.all, true);
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: t3 })).status, 401, 'cerrar sesión en todos invalida los emitidos antes');
  const t4 = await login(srv.base); assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: t4 })).status, 200, 'uno nuevo vale');
  assert.equal((await http(srv.base, 'POST', '/api/master/logout', { token: t4, body: { all: 'si' } })).status, 400, 'cuerpo inválido');
  assert.equal((await http(srv.base, 'POST', '/api/master/logout', {})).status, 401, 'sin token no hay cierre de sesión');
  assert.equal((await http(srv.base, 'POST', '/api/master/logout', { token: 'x.y' })).status, 401);
});

test('cerrar sesión de operador NO expulsa a un Master ya conectado ni invalida su token de sesión (esos los gobierna el epoch de la sesión)', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  const m = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  await http(srv.base, 'POST', '/api/master/logout', { token: op, body: { all: true } });
  m.send({ protocolVersion: 1, type: 'command', payload: { effect: 'solid', color: '#FF3B30' } });
  assert.ok((await m.waitFor('ack')).stateVersion >= 1, 'el panel de la sesión sigue operando');
  assert.equal((await http(srv.base, 'POST', `/api/sessions/${s.sessionId}/revoke`, { token: op })).status, 401, 'pero el operador ya no puede revocar sin volver a iniciar sesión');
});

test('salud pública mínima (sin tiempo de actividad ni detalles); estado de seguridad solo para el operador y sin secretos', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const h = await http(srv.base, 'GET', '/healthz'); assert.deepEqual(h.json, { ok: true, status: 'alive' });
  assert.deepEqual((await http(srv.base, 'GET', '/readyz')).json, { ready: true });
  assert.equal((await http(srv.base, 'GET', '/api/admin/status')).status, 401);
  const op = await login(srv.base); const st = await http(srv.base, 'GET', '/api/admin/status', { token: op });
  assert.equal(st.json.security.tokenSecretSource, 'override'); assert.equal(st.json.security.rateLimit.degraded, false); assert.equal(st.json.security.operatorGeneration, 0);
  const all = st.text + srv.logs.join('\n');
  for (const secret of [PASSWORD, 'secreto-de-prueba-0123456789abcdef', op]) assert.ok(!all.includes(secret), 'ningún secreto ni token en la respuesta ni en los logs');
  assert.equal(h.headers.get('cross-origin-resource-policy'), 'same-origin');
});

test('redirección http → https (con proxy de confianza): 308 a la URL canónica; https, sondeos de salud y peticiones sin X-Forwarded-Proto no se redirigen; el destino no es manipulable', async t => {
  const srv = await startServer({ httpsRedirect: true, trustProxyHops: 1, publicBaseUrl: 'https://evento.example' }); t.after(srv.stop);
  const r = await raw(srv.base, 'GET', '/master?x=1', { headers: { 'x-forwarded-proto': 'http', host: 'evil.example' } });
  assert.equal(r.status, 308); assert.equal(r.headers.get('location'), 'https://evento.example/master?x=1', 'siempre la URL canónica, nunca el Host recibido');
  const odd = await raw(srv.base, 'GET', '//evil.example/x', { headers: { 'x-forwarded-proto': 'http' } });
  assert.equal(odd.status, 308); assert.ok(odd.headers.get('location').startsWith('https://evento.example/'), 'tampoco con rutas raras: ' + odd.headers.get('location'));
  assert.equal((await raw(srv.base, 'GET', '/master', { headers: { 'x-forwarded-proto': 'https' } })).status, 200);
  assert.equal((await raw(srv.base, 'GET', '/master')).status, 200, 'sin X-Forwarded-Proto no se redirige (acceso interno)');
  assert.equal((await raw(srv.base, 'GET', '/healthz', { headers: { 'x-forwarded-proto': 'http' } })).status, 200, 'los sondeos de salud quedan exentos');
  assert.equal((await raw(srv.base, 'GET', '/readyz', { headers: { 'x-forwarded-proto': 'http' } })).status, 200);
  assert.ok(srv.app.metrics.get('https_redirects') >= 2);
});

test('origen WebSocket con URL canónica (modo producción): solo la URL pública (esquema+host+puerto) y ALLOWED_ORIGINS; el Host recibido NO sirve de referencia', async t => {
  const srv = await startServer({ originFromHost: false, publicBaseUrl: 'https://evento.example', allowedOrigins: ['https://otro.example'], allowNoOrigin: false }); t.after(srv.stop);
  await new Client(srv.wsUrl, { origin: 'https://evento.example' }).open();
  await new Client(srv.wsUrl, { origin: 'https://otro.example' }).open();
  for (const origin of [`http://127.0.0.1:${srv.port}`, 'http://evento.example', 'https://evento.example:8443', 'https://evil.example', 'null', 'https://evento.example.evil.example', 'file://'])
    await assert.rejects(new Client(srv.wsUrl, { origin }).open(), e => e.status === 403, origin);
  await assert.rejects(new Client(srv.wsUrl).open(), e => e.status === 403, 'sin Origin');
  assert.ok(srv.app.metrics.get('ws_rejected_origin') >= 7);
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  assert.equal(s.joinUrl, `https://evento.example/?s=${s.sessionId}&mode=remote`, 'el enlace del QR sale de la URL canónica, no del Host');
});

test('consulta pública de sesión inexistente: límite PROPIO (429) que NO cuenta contra las uniones WebSocket del NAT; el vencimiento del hello tampoco', { timeout: 30000 }, async t => {
  const srv = await startServer({ statusMissPerMin: 3, badJoinPerMinPerIp: 2, helloTimeoutMs: 300 }); t.after(srv.stop);
  const codes = []; for (let i = 0; i < 5; i++) codes.push((await http(srv.base, 'GET', `/api/sessions/${fakeCode(i)}/status`)).status);
  assert.deepEqual(codes, [404, 404, 404, 429, 429]);
  assert.equal(srv.app.metrics.get('ws_rejected_badjoin'), 0);
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  for (let i = 0; i < 4; i++) { const idle = await new Client(srv.wsUrl).open(); assert.equal((await idle.waitClose(2000)).code, 4408, 'hello vencido'); }
  const ok = await joinPublic(srv.wsUrl, s.sessionId, dev(1)); assert.ok(ok.welcome, 'un teléfono legítimo del mismo NAT sigue entrando');
  assert.equal(srv.app.metrics.get('ws_rejected_badjoin'), 0); assert.ok(srv.app.metrics.get('ws_hello_timeouts') >= 4);
  // …pero el control contra adivinar códigos de sesión sigue vigente: 2 códigos inexistentes por WebSocket bloquean la IP
  for (let i = 0; i < 2; i++) { const c = await new Client(srv.wsUrl).open(); c.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: fakeCode(500 + i) }); await c.waitClose(); }
  await sleep(50); await assert.rejects(new Client(srv.wsUrl).open(), e => e.status === 429);
});

test('un hello a una sesión inexistente no crea sala (ni suscripción) y se cuenta como unión fallida', async t => {
  const srv = await startServer(); t.after(srv.stop);
  for (let i = 0; i < 5; i++) {
    const c = await new Client(srv.wsUrl).open(); c.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: fakeCode(100 + i) });
    assert.equal((await c.waitFor('error')).code, 'SESSION_NOT_FOUND'); assert.equal((await c.waitClose()).code, 4404);
  }
  assert.equal(srv.app.hub.roomCount(), 0, 'ninguna sala creada'); assert.equal(srv.app.metrics.get('bad_join'), 5);
  const op = await login(srv.base); const s = await createSession(srv.base, op); const p = await joinPublic(srv.wsUrl, s.sessionId, dev(9));
  assert.equal(srv.app.hub.roomCount(), 1); assert.ok(p.welcome, 'y una sesión real sigue funcionando');
});

test('IP del cliente: con proxy de confianza se agrupa IPv6 por /64 (rotar direcciones no evita el límite de login); una cabecera ilegible cae a la IP del socket', async t => {
  const srv = await startServer({ trustProxyHops: 1, loginPerMin: 3 }); t.after(srv.stop);
  const tryLogin = xff => http(srv.base, 'POST', '/api/master/login', { body: { password: 'mal' }, headers: { 'x-forwarded-for': xff } }).then(r => r.status);
  const a = []; for (const last of ['1', '2', 'ffff::3', '4']) a.push(await tryLogin('198.51.100.9, 2001:db8:1:2:' + (last.includes('::') ? last : ':' + last)));
  assert.deepEqual(a, [401, 401, 401, 429], 'cuatro direcciones del MISMO /64 comparten el límite');
  assert.equal(await tryLogin('2001:db8:9:9::1'), 401, 'otro /64 tiene su propio cupo');
  const g = []; for (let i = 0; i < 4; i++) g.push(await tryLogin('esto no es una ip ' + i)); assert.deepEqual(g, [401, 401, 401, 429], 'basura → IP del socket: comparten cupo y no se «inventan» claves nuevas');
  const spoof = []; for (let i = 0; i < 4; i++) spoof.push(await tryLogin(`203.0.113.${i}, 192.0.2.77`)); assert.deepEqual(spoof, [401, 401, 401, 429], 'solo cuenta la entrada agregada por NUESTRO proxy (la última): las anteriores no se pueden falsificar');
});

test('límite de la API compartido por la misma clave: 429 con Retry-After y sin filtrar datos; el servicio sigue respondiendo', async t => {
  const srv = await startServer({ httpPerMin: 5 }); t.after(srv.stop);
  const op = await login(srv.base); const out = [];
  for (let i = 0; i < 8; i++) out.push((await http(srv.base, 'GET', '/api/sessions', { token: op })).status);
  assert.deepEqual(out.slice(0, 4), [200, 200, 200, 200]); assert.ok(out.slice(5).every(s => s === 429), JSON.stringify(out));
  const r = await http(srv.base, 'GET', '/api/sessions', { token: op }); assert.equal(r.headers.get('retry-after'), '30'); assert.deepEqual(r.json, { error: 'RATE_LIMITED' });
  assert.equal((await http(srv.base, 'GET', '/healthz')).status, 200, 'la salud queda exenta');
});
