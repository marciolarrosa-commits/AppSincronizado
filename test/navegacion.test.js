'use strict';
// Navegación y páginas: la raíz es la presentación de V3, /master el panel, los QR abren la pantalla del participante y la app Flash anterior
// convive detrás de un interruptor del operador. Todo contra el servidor REAL (sin simulaciones).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, http, login, createSession, joinPublic, joinMaster, dev } = require('./helpers');
const { createMemoryStore } = require('../src/store/memory');
const { loadConfig } = require('../src/config');

const get = (base, p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts }).then(async r => ({ status: r.status, headers: r.headers, text: await r.text() }));
const FLASH_MARK = 'El flash de cada celular, al compás de la música del lugar';   // texto de la app anterior
const PARTICIPANT_MARK = 'id="remote-stage"';                                          // cliente remoto de V3

test('/ es la presentación de Destello·Sync V3 (no la app Flash anterior) y enlaza al panel', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const r = await get(srv.base, '/');
  assert.equal(r.status, 200); assert.equal(r.headers.get('location'), null, 'sin redirecciones');
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.ok(r.text.includes('Abrir panel del operador'));
  assert.match(r.text, /<a class="btn primary" id="open-master" href="\/master">/);
  assert.ok(!r.text.includes(FLASH_MARK), 'la portada no presenta la app del micrófono');
  assert.ok(!r.text.includes('id="btn-create"'), 'la portada no tiene el botón «Crear sesión» de la app anterior');
  assert.ok(!r.text.includes(PARTICIPANT_MARK), 'la portada no es la pantalla del participante');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self' blob: 'sha256-/, 'su script en línea está autorizado por hash, sin unsafe-inline');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(r.headers.get('content-security-policy')));
  // sin parámetros relevantes (p. ej. UTM) sigue siendo la portada
  assert.ok((await get(srv.base, '/?utm_source=qr')).text.includes('Abrir panel del operador'));
});

test('/master sirve el panel del operador (también con barra final y sin depender de la caché)', async t => {
  const srv = await startServer(); t.after(srv.stop);
  for (const p of ['/master', '/master/']) {
    const r = await get(srv.base, p);
    assert.equal(r.status, 200, p); assert.equal(r.headers.get('location'), null);
    assert.ok(r.text.includes('<title>Destello·Sync Master</title>') && r.text.includes('/js/master.js'), p);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
  }
  // revalidación: ETag -> 304, el contenido nunca queda "pegado" en una caché intermedia
  const first = await fetch(srv.base + '/master'); await first.arrayBuffer();
  const again = await fetch(srv.base + '/master', { headers: { 'if-none-match': first.headers.get('etag') } });
  assert.equal(again.status, 304);
});

test('enlaces de participante /?s=CODIGO&mode=remote y /?mode=remote: la pantalla controlada por el operador, SIEMPRE disponible (con Flash deshabilitada)', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  assert.match(s.joinUrl, /\/\?s=[A-HJ-NP-Z2-9]{6}&mode=remote$/, 'formato del QR conservado');
  const path = new URL(s.joinUrl).pathname + new URL(s.joinUrl).search;
  for (const p of [path, `/?mode=remote&s=${s.sessionId}`, '/?mode=remote', path + '&debug=1']) {
    const r = await get(srv.base, p);
    assert.equal(r.status, 200, p); assert.equal(r.headers.get('location'), null, p);
    assert.ok(r.text.includes(PARTICIPANT_MARK) && r.text.includes('/js/remote.js'), p);
    assert.ok(r.text.includes("mode=remote"), 'el script de cabecera que oculta la interfaz anterior sigue presente');
  }
  // y el WebSocket de ese participante funciona de punta a punta con la orden del operador
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phone = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  master.send({ protocolVersion: 1, type: 'command', commandId: 'c-nav-0001', payload: { effect: 'solid', color: '#FF3B30' } });
  const ack = await master.waitFor('ack'); assert.equal(ack.stateVersion, 1);
  const st = await phone.waitFor('state'); assert.equal(st.payload.color, '#FF3B30');
});

test('app Flash anterior: deshabilitada por defecto (403, sin caché) y sin efecto sobre la pantalla de participantes', async t => {
  const srv = await startServer(); t.after(srv.stop);
  for (const p of ['/flash', '/flash/', '/flash.html', '/flash?s=ABC234', '/?s=ABC234', '/?s=ABC234&mode=otro']) {
    const r = await get(srv.base, p);
    assert.equal(r.status, 403, p);
    assert.equal(r.headers.get('cache-control'), 'no-store', p);
    assert.ok(r.text.includes('La app Flash no está habilitada'), p);
    assert.ok(!r.text.includes(FLASH_MARK), p);
  }
  assert.equal((await get(srv.base, '/flash', { method: 'HEAD' })).status, 403);
  assert.ok((await get(srv.base, '/?s=ABC234&mode=remote')).text.includes(PARTICIPANT_MARK), 'el participante V3 no depende del interruptor');
  assert.equal(srv.app.metrics.get('flash_page_blocked') > 0, true);
});

test('el operador habilita y deshabilita la app Flash; /flash y los QR antiguos /?s=CODIGO responden según el estado', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const op = await login(srv.base);
  const st0 = await http(srv.base, 'GET', '/api/admin/flash', { token: op });
  assert.equal(st0.status, 200); assert.equal(st0.json.enabled, false); assert.equal(st0.json.path, '/flash'); assert.match(st0.json.url, /\/flash$/);

  const on = await http(srv.base, 'POST', '/api/admin/flash', { token: op, body: { enabled: true } });
  assert.equal(on.status, 200); assert.equal(on.json.enabled, true);
  for (const p of ['/flash', '/flash?s=ABC234', '/?s=ABC234', '/flash.html']) {
    const r = await get(srv.base, p);
    assert.equal(r.status, 200, p); assert.ok(r.text.includes(FLASH_MARK), p); assert.equal(r.headers.get('cache-control'), 'no-cache');
  }
  assert.ok((await http(srv.base, 'GET', '/api/admin/status', { token: op })).json.flash.enabled === true);

  const off = await http(srv.base, 'POST', '/api/admin/flash', { token: op, body: { enabled: false } });
  assert.equal(off.json.enabled, false);
  assert.equal((await get(srv.base, '/flash')).status, 403);
  assert.equal((await get(srv.base, '/')).status, 200, 'la portada no cambia');
  // un navegador con una copia en caché no puede saltarse el interruptor: se evalúa ANTES de responder 304
  assert.equal((await fetch(srv.base + '/flash', { headers: { 'if-none-match': '"cualquiera"' } })).status, 403);
});

test('interruptor Flash: solo el operador autenticado, cuerpo validado y sin filtrar secretos', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  assert.equal((await http(srv.base, 'GET', '/api/admin/flash')).status, 401);
  assert.equal((await http(srv.base, 'POST', '/api/admin/flash', { body: { enabled: true } })).status, 401);
  assert.equal((await http(srv.base, 'POST', '/api/admin/flash', { token: 'basura', body: { enabled: true } })).status, 401);
  // el token de Master de una sesión (WebSocket) NO sirve como operador
  assert.equal((await http(srv.base, 'POST', '/api/admin/flash', { token: s.masterToken, body: { enabled: true } })).status, 401);
  for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }, { enable: true }]) {
    const r = await http(srv.base, 'POST', '/api/admin/flash', { token: op, body });
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.json.error, 'INVALID_BODY');
  }
  assert.equal((await http(srv.base, 'GET', '/api/admin/flash', { token: op })).json.enabled, false, 'los intentos inválidos no cambian nada');
  const big = await http(srv.base, 'POST', '/api/admin/flash', { token: op, body: { enabled: true, x: 'a'.repeat(6000) } });
  assert.equal(big.status, 413);
  assert.ok(!JSON.stringify(srv.logs).includes(op), 'el token no se escribe en los logs');
});

test('el interruptor Flash se comparte por el almacenamiento: otra instancia y un reinicio con el mismo almacenamiento lo respetan', async t => {
  const cfg = { ...loadConfig({}), sessionTtlS: 600 };
  const store = createMemoryStore(cfg); await store.init(); t.after(() => store.close());
  const A = await startServer({}, { store }); t.after(A.stop);
  const op = await login(A.base);
  await http(A.base, 'POST', '/api/admin/flash', { token: op, body: { enabled: true } });
  assert.equal(await store.getSetting('flashEnabled'), '1');
  const B = await startServer({}, { store }); t.after(B.stop);          // arranca después: lee el valor guardado al iniciar
  assert.equal((await get(B.base, '/flash')).status, 200);
  assert.equal((await http(B.base, 'GET', '/api/admin/flash', { token: await login(B.base) })).json.enabled, true);
});

test('FLASH_DEFAULT_ENABLED define solo el estado inicial; el valor guardado por el operador manda', async t => {
  assert.equal(loadConfig({}).flashDefaultEnabled, false);
  assert.equal(loadConfig({ FLASH_DEFAULT_ENABLED: 'true' }).flashDefaultEnabled, true);
  const srv = await startServer({ flashDefaultEnabled: true }); t.after(srv.stop);
  assert.equal((await get(srv.base, '/flash')).status, 200);
  const op = await login(srv.base);
  await http(srv.base, 'POST', '/api/admin/flash', { token: op, body: { enabled: false } });
  assert.equal((await get(srv.base, '/flash')).status, 403);
});

test('los metadatos del editor (*.artifact.json) no se publican y las rutas desconocidas dan 404 JSON', async t => {
  const srv = await startServer(); t.after(srv.stop);
  assert.equal((await get(srv.base, '/index.html.artifact.json')).status, 404);
  assert.equal((await get(srv.base, '/master.html.artifact.json')).status, 404);
  const nf = await get(srv.base, '/no-existe'); assert.equal(nf.status, 404); assert.equal(JSON.parse(nf.text).error, 'NOT_FOUND');
  assert.equal((await get(srv.base, '/..%2fserver.js')).status, 400);
  assert.equal((await get(srv.base, '/.env')).status, 404);
});

test('configuración de producción: errores de arranque claros y PUBLIC_BASE_URL coherente', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /Falta MASTER_PASSWORD/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', MASTER_PASSWORD: 'corta' }), /al menos 12/);
  const ok = { NODE_ENV: 'production', MASTER_PASSWORD: 'x'.repeat(12) };
  assert.throws(() => loadConfig({ ...ok, PUBLIC_BASE_URL: 'http://appsincronizado.onrender.com' }), /https/);
  assert.throws(() => loadConfig({ ...ok, PUBLIC_BASE_URL: 'https://appsincronizado.onrender.com/ruta' }), /PUBLIC_BASE_URL inválida/);
  assert.equal(loadConfig({ ...ok, PUBLIC_BASE_URL: 'https://appsincronizado.onrender.com/' }).publicBaseUrl, 'https://appsincronizado.onrender.com');
  assert.equal(loadConfig({ ...ok, PUBLIC_BASE_URL: 'https://appsincronizado.onrender.com' }).allowNoOrigin, false);
});

test('verificación del despliegue: la versión activa figura en /api/admin/status (solo operador) y los archivos nuevos del panel se publican', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const pkg = require('../package.json');
  assert.equal((await http(srv.base, 'GET', '/api/admin/status')).status, 401, 'sin operador no se revela la versión');
  const st = await http(srv.base, 'GET', '/api/admin/status', { token: await login(srv.base) });
  assert.equal(st.json.version, pkg.version);
  assert.equal((await get(srv.base, '/js/orders.js')).status, 200, 'orders.js (ciclo de vida de órdenes) está publicado');
});

test('/colores (calibración de color) se publica sin redirecciones, con su script autorizado por hash y sin depender de sesión ni de Flash', async t => {
  const srv = await startServer(); t.after(srv.stop);
  for (const p of ['/colores', '/colores/', '/colores.html']) {
    const r = await get(srv.base, p);
    assert.equal(r.status, 200, p); assert.equal(r.headers.get('location'), null);
    assert.ok(r.text.includes('<title>Calibración de color</title>') && r.text.includes('id="ramp"'), p);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self' blob: 'sha256-/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(r.headers.get('content-security-policy')));
  }
});
