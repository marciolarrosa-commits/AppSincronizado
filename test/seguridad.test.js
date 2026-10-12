'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, http, login, createSession, joinPublic, joinMaster, sleep, dev, Client, PASSWORD } = require('./helpers');

const cmd = (c = '#FF3B30') => ({ protocolVersion: 1, type: 'command', payload: { effect: 'solid', color: c } });

test('el panel Master exige autenticación: sin token, token inválido y contraseña incorrecta', async t => {
  const srv = await startServer(); t.after(srv.stop);
  assert.equal((await http(srv.base, 'POST', '/api/sessions', { body: {} })).status, 401);
  assert.equal((await http(srv.base, 'POST', '/api/sessions', { token: 'abc.def', body: {} })).status, 401);
  assert.equal((await http(srv.base, 'GET', '/api/sessions')).status, 401);
  assert.equal((await http(srv.base, 'GET', '/api/admin/status')).status, 401);
  assert.equal((await http(srv.base, 'GET', '/metrics')).status, 401);
  const bad = await http(srv.base, 'POST', '/api/master/login', { body: { password: 'incorrecta' } });
  assert.equal(bad.status, 401); assert.ok(!bad.text.includes(PASSWORD));
  assert.equal((await http(srv.base, 'POST', '/api/master/login', { body: { password: 12345 } })).status, 401);
  assert.equal((await http(srv.base, 'POST', '/api/master/login', { body: { password: 'x'.repeat(5000) } })).status, 413);
});

test('token de operador vencido o manipulado es rechazado', async t => {
  const srv = await startServer({ operatorTokenTtlS: 1 }); t.after(srv.stop);
  const op = await login(srv.base);
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: op })).status, 200);
  const [body, mac] = op.split('.');
  const tampered = Buffer.from(JSON.stringify({ r: 'op', exp: 9999999999 })).toString('base64url') + '.' + mac;
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: tampered })).status, 401);
  await sleep(1300);
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: op })).status, 401, 'vencido');
});

test('un token de Master solo sirve para SU sesión y no sirve como token de operador', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const op = await login(srv.base);
  const a = await createSession(srv.base, op); const b = await createSession(srv.base, op);
  const c = await new Client(srv.wsUrl).open();
  c.send({ protocolVersion: 1, type: 'hello', role: 'master', sessionId: b.sessionId, token: a.masterToken });
  assert.equal((await c.waitFor('error')).code, 'UNAUTHORIZED');
  assert.equal((await c.waitClose()).code, 4401);
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: a.masterToken })).status, 401);
});

test('revocar tokens invalida los existentes: el Master conectado es expulsado al siguiente comando', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const op = await login(srv.base);
  const s = await createSession(srv.base, op);
  const m = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  assert.equal((await http(srv.base, 'POST', `/api/sessions/${s.sessionId}/revoke`, { token: op, body: {} })).status, 200);
  m.send(cmd());
  assert.equal((await m.waitFor('error')).code, 'UNAUTHORIZED');
  assert.equal((await m.waitClose()).code, 4401);
  const c = await new Client(srv.wsUrl).open();
  c.send({ protocolVersion: 1, type: 'hello', role: 'master', sessionId: s.sessionId, token: s.masterToken });
  assert.equal((await c.waitFor('error')).code, 'UNAUTHORIZED');
  // un token nuevo funciona
  const fresh = await http(srv.base, 'POST', `/api/sessions/${s.sessionId}/master-token`, { token: op, body: {} });
  await joinMaster(srv.wsUrl, s.sessionId, fresh.json.masterToken);
});

test('un participante NO puede enviar órdenes administrativas ni cambiar el estado', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const spy = await joinPublic(srv.wsUrl, s.sessionId, dev(2));
  const attacker = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  for (const m of [cmd('#FFFFFF'), { protocolVersion: 1, type: 'stop' }, { protocolVersion: 1, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: true }]) {
    attacker.send(m);
    assert.equal((await attacker.waitFor('error')).code, 'FORBIDDEN');
    await sleep(1050);   // el servidor responde un error por segundo como máximo
  }
  await sleep(200);
  assert.equal(spy.msgs.filter(m => m.type === 'state').length, 0);
  assert.equal((await srv.app.sessions.get(s.sessionId)).state.stateVersion, 0);
  assert.equal((await srv.app.sessions.get(s.sessionId)).strobeEnabled, false);
  assert.ok(srv.app.metrics.get('forbidden_commands') >= 3);
});

test('un participante no puede presentarse como Master ni enviar token', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const c1 = await new Client(srv.wsUrl).open();
  c1.send({ protocolVersion: 1, type: 'hello', role: 'master', sessionId: s.sessionId, token: 'x'.repeat(40) });
  assert.equal((await c1.waitFor('error')).code, 'UNAUTHORIZED');
  const c2 = await new Client(srv.wsUrl).open();
  c2.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: s.sessionId, token: s.masterToken });
  assert.equal((await c2.waitFor('error')).code, 'INVALID_FIELD');
  const c3 = await new Client(srv.wsUrl).open();
  c3.send({ protocolVersion: 1, type: 'hello', role: 'admin', sessionId: s.sessionId });
  assert.equal((await c3.waitFor('error')).code, 'INVALID_ROLE');
});

test('sesión inexistente o con formato inválido se rechaza sin revelar información', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const c1 = await new Client(srv.wsUrl).open();
  c1.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: 'ZZZZZZ' });
  assert.equal((await c1.waitFor('error')).code, 'SESSION_NOT_FOUND');
  assert.equal((await c1.waitClose()).code, 4404);
  const c2 = await new Client(srv.wsUrl).open();
  c2.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: '../../etc' });
  assert.equal((await c2.waitFor('error')).code, 'INVALID_SESSION');
});

test('fuerza bruta de códigos de sesión: tras varios intentos fallidos la IP queda bloqueada', async t => {
  const srv = await startServer({ badJoinPerMinPerIp: 5 }); t.after(srv.stop);
  for (let i = 0; i < 5; i++) {
    const c = await new Client(srv.wsUrl).open();
    c.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: 'AAAAA' + 'ABCDEF'[i] });
    await c.waitClose();
  }
  await assert.rejects(new Client(srv.wsUrl).open(), e => e.status === 429);
});

test('Origin no autorizado es rechazado (CSWSH); el mismo origen y los orígenes permitidos pasan', async t => {
  const srv = await startServer({ allowNoOrigin: false, allowedOrigins: ['https://evento.example'] }); t.after(srv.stop);
  await assert.rejects(new Client(srv.wsUrl, { origin: 'https://evil.example' }).open(), e => e.status === 403);
  await assert.rejects(new Client(srv.wsUrl).open(), e => e.status === 403, 'sin Origin y allowNoOrigin=false');
  await new Client(srv.wsUrl, { origin: `http://127.0.0.1:${srv.port}` }).open();
  await new Client(srv.wsUrl, { origin: 'https://evento.example' }).open();
  assert.ok(srv.app.metrics.get('ws_rejected_origin') >= 2);
});

test('límite de intentos de login por IP', async t => {
  const srv = await startServer({ loginPerMin: 4 }); t.after(srv.stop);
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await http(srv.base, 'POST', '/api/master/login', { body: { password: 'mal' } })).status);
  assert.deepEqual(codes.slice(0, 4), [401, 401, 401, 401]);
  assert.deepEqual(codes.slice(4), [429, 429]);
});

test('el servidor protege las rutas estáticas (path traversal, archivos internos) y fija cabeceras de seguridad', async t => {
  const srv = await startServer(); t.after(srv.stop);
  for (const p of ['/../server.js', '/%2e%2e/package.json', '/..%2f..%2fserver.js', '/src/app.js', '/.git/config', '/package.json', '/%00', '/%E0%A4%A']) {
    const r = await http(srv.base, 'GET', p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.ok(!/require\(|createApp|"dependencies"/.test(r.text), 'no debe filtrar código ni configuración');
  }
  const page = await http(srv.base, 'GET', '/master');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' blob:;/, 'el panel Master no tiene scripts en línea: solo archivos propios');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(page.headers.get('content-security-policy')), 'scripts sin unsafe-inline');
  const pub = await http(srv.base, 'GET', '/');
  assert.match(pub.headers.get('content-security-policy'), /script-src 'self' blob: 'sha256-/, 'la página pública autoriza sus scripts en línea por hash');
  assert.equal(page.headers.get('access-control-allow-origin'), null, 'sin CORS abierto');
  const api = await http(srv.base, 'POST', '/api/master/login', { body: { password: 'x' } });
  assert.equal(api.headers.get('access-control-allow-origin'), null);
});

test('el estado público de una sesión no revela estado ni conteos; el operador sí los ve', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const op = await login(srv.base);
  const s = await createSession(srv.base, op);
  const pub = await http(srv.base, 'GET', `/api/sessions/${s.sessionId}/status`);
  assert.deepEqual(pub.json, { sessionId: s.sessionId, exists: true });
  const full = await http(srv.base, 'GET', `/api/sessions/${s.sessionId}/status`, { token: op });
  assert.ok('state' in full.json && 'connected' in full.json);
  assert.equal((await http(srv.base, 'GET', '/api/sessions/AAAAAA/status')).status, 404);
});

test('validación estricta de órdenes: campos desconocidos, colores, rangos y frecuencia máxima de strobe', async t => {
  const srv = await startServer({ masterCommandsPerSec: 1000, masterCommandBurst: 1000 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const m = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  m.send({ protocolVersion: 1, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: true }); await m.waitFor('config');
  const bad = [
    [{ effect: 'solid', color: 'rojo' }, 'INVALID_COLOR'],
    [{ effect: 'solid', color: '#12345' }, 'INVALID_COLOR'],
    [{ effect: 'solid', color: '#FFFFFF', label: '<script>alert(1)</script>' }, 'UNKNOWN_FIELD'],
    [{ effect: 'explosion', color: '#FFFFFF' }, 'INVALID_EFFECT'],
    [{ effect: 'pulse', color: '#FFFFFF', periodMs: 50 }, 'OUT_OF_RANGE'],
    [{ effect: 'pulse', color: '#FFFFFF', periodMs: '1000' }, 'INVALID_FIELD'],
    [{ effect: 'strobe', color: '#FFFFFF', hz: 10 }, 'OUT_OF_RANGE'],
    [{ effect: 'strobe', color: '#FFFFFF', hz: 3.5 }, 'OUT_OF_RANGE'],
    [{ effect: 'strobe', color: '#FFFFFF', hz: 2, durationMs: 3600000 }, 'OUT_OF_RANGE'],
    [{ effect: 'solid', color: '#FFFFFF', intensity: 5 }, 'OUT_OF_RANGE'],
    [{ effect: 'solid', color: '#FFFFFF', fadeMs: 1e9 }, 'OUT_OF_RANGE'],
    [{ effect: 'solid', color: '#FFFFFF', fadeMs: NaN }, 'INVALID_FIELD']
  ];
  for (const [payload, code] of bad) {
    m.send({ protocolVersion: 1, type: 'command', payload });
    const e = await m.waitFor('error');
    assert.equal(e.code, code, JSON.stringify(payload));
    await sleep(1010);   // el servidor limita los errores a uno por segundo por conexión
    if (m.closed) assert.fail('la conexión no debería cerrarse por órdenes inválidas aisladas');
    if (bad.indexOf(bad.find(b => b[0] === payload)) > 5) break;   // acotar la duración de la prueba
  }
  assert.equal((await srv.app.sessions.get(s.sessionId)).state.stateVersion, 0, 'ninguna orden inválida modifica el estado');
});

test('los logs no contienen tokens ni contraseñas', async t => {
  const srv = await startServer({ logLevel: 'debug' }); t.after(srv.stop);
  const op = await login(srv.base);
  await http(srv.base, 'POST', '/api/master/login', { body: { password: 'intento-secreto-incorrecto' } });
  const s = await createSession(srv.base, op);
  const m = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  m.send(cmd()); await m.waitFor('ack');
  await sleep(100);
  const all = srv.logs.join('\n');
  assert.ok(all.length > 0);
  for (const secret of [op, s.masterToken, PASSWORD, 'intento-secreto-incorrecto']) assert.ok(!all.includes(secret), 'secreto filtrado en logs');
});

test('métricas y estado de administración solo con credenciales', async t => {
  const srv = await startServer({ metricsToken: 'metricas-token-de-prueba' }); t.after(srv.stop);
  const op = await login(srv.base);
  assert.equal((await http(srv.base, 'GET', '/metrics', { token: 'metricas-token-de-prueba' })).status, 200);
  assert.equal((await http(srv.base, 'GET', '/metrics', { token: op })).status, 200);
  assert.equal((await http(srv.base, 'GET', '/metrics', { token: 'otro' })).status, 401);
  const st = await http(srv.base, 'GET', '/api/admin/status', { token: op });
  assert.equal(st.status, 200); assert.ok(st.json.health.status);
  const rz = await http(srv.base, 'GET', '/readyz');
  assert.deepEqual(rz.json, { ready: true }, 'readyz público sin información sensible');
  assert.ok(!(await http(srv.base, 'GET', '/healthz')).text.includes(srv.app.config.instanceId));
});
