'use strict';
// COBERTURA DE PANTALLA y MODO ESPECTÁCULO en Chrome real con EMULACIÓN móvil (viewport, DPR, user agent, táctil).
// IMPORTANTE: es emulación sobre Chrome de escritorio. NO demuestra el comportamiento de Safari en iPhone ni de Chrome en un Android físico:
// ver docs/COBERTURA_PANTALLA.md (protocolo de ensayo físico). Aquí se verifica el PROPIO documento: geometría, capas, estilos y píxeles renderizados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, login, createSession, joinMaster, sleep } = require('../test/helpers');
const { decodePng, checkCoverage, mismatchRatio } = require('../test/png');
const FX = require('../public/js/effects');

const CANDIDATES = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
const skip = CHROME ? false : 'No hay Chrome/Edge: CHROME_PATH';

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const PROFILES = [
  { name: 'iPhone 14 vertical (EMULACIÓN)', w: 390, h: 844, dpr: 3, ua: UA_IPHONE },
  { name: 'iPhone 14 horizontal (EMULACIÓN)', w: 844, h: 390, dpr: 3, ua: UA_IPHONE, landscape: true },
  { name: 'Pixel 7 vertical (EMULACIÓN, DPR fraccionario 2,625)', w: 412, h: 915, dpr: 2.625, ua: UA_ANDROID },
  { name: 'Pixel 7 horizontal (EMULACIÓN)', w: 915, h: 412, dpr: 2.625, ua: UA_ANDROID, landscape: true },
  { name: 'Teléfono pequeño 360x640 (EMULACIÓN)', w: 360, h: 640, dpr: 2, ua: UA_ANDROID },
  { name: 'Tableta 820x1180 (EMULACIÓN)', w: 820, h: 1180, dpr: 2, ua: UA_ANDROID }
];

async function setup(t, overrides = {}) {
  const puppeteer = require('puppeteer-core');
  const srv = await startServer({ wsConnectPerMinPerIp: 1e6, httpPerMin: 1e6, ...overrides }); t.after(srv.stop);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  async function phone(profile, { url = s.joinUrl, init, connect = true } = {}) {
    const page = await (await browser.createBrowserContext()).newPage();
    await page.setUserAgent(profile.ua);
    await page.setViewport({ width: profile.w, height: profile.h, deviceScaleFactor: profile.dpr, isMobile: true, hasTouch: true, isLandscape: Boolean(profile.landscape) });
    if (init) await page.evaluateOnNewDocument(init);
    await page.goto(url);
    if (connect) await page.waitForFunction(() => window.DestelloRemote && window.DestelloRemote._state.connected, { timeout: 12000 });
    return page;
  }
  return { srv, s, master, phone, browser };
}
const color = (c, extra = {}, lead = 300) => ({ protocolVersion: 1, type: 'command', leadMs: lead, payload: { effect: 'solid', color: c, fadeMs: 0, ...extra } });
const hex2rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const state = p => p.evaluate(() => { const S = window.DestelloRemote._state; return { mode: S.mode, panel: S.panelOpen, version: S.lastVersion, shown: S.shown.map(Math.round), connected: S.connected, fs: S.fs, applied: S.stats.applied }; });
async function waitShown(p, rgb, timeout = 5000, tol = 3) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const s = await state(p); if (s.shown.every((v, i) => Math.abs(v - rgb[i]) <= tol)) return true; await sleep(30); }
  return false;
}

// Inspección geométrica y de capas de lo que está EFECTIVAMENTE sobre la pantalla
function inspect(page) {
  return page.evaluate(() => {
    const W = innerWidth, H = innerHeight;
    const r = document.getElementById('remote-light').getBoundingClientRect();
    const vis = id => { const e = document.getElementById(id); if (!e) return false; const cs = getComputedStyle(e); const b = e.getBoundingClientRect(); return !e.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0 && Number(cs.opacity) > 0; };
    const pts = []; for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) pts.push([Math.min(W - 1, Math.round((W - 1) * i / 8)), Math.min(H - 1, Math.round((H - 1) * j / 8))]);
    const covered = pts.filter(([x, y]) => { const e = document.elementFromPoint(x, y); return !e || e.id !== 'remote-light'; }).map(([x, y]) => [x, y, (document.elementFromPoint(x, y) || {}).id || null]);
    const meta = document.querySelector('meta[name="theme-color"]');
    return { W, H, dpr: devicePixelRatio, light: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      ui: { ui: vis('remote-ui'), banner: vis('remote-banner'), debug: vis('remote-debug'), diag: vis('remote-diag'), enter: vis('remote-enter'), session: vis('remote-session'), conn: vis('remote-connection'), label: vis('remote-label') },
      covered, htmlBg: getComputedStyle(document.documentElement).backgroundColor, bodyBg: getComputedStyle(document.body).backgroundColor,
      lightBg: getComputedStyle(document.getElementById('remote-light')).backgroundColor, stageBg: getComputedStyle(document.getElementById('remote-stage')).backgroundColor,
      theme: meta && meta.getAttribute('content'), scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight, activeEl: document.activeElement && document.activeElement.tagName };
  });
}
const toCss = rgb => `rgb(${rgb.join(', ')})`;
async function assertFullCoverage(page, hex, label) {
  const rgb = hex2rgb(hex); const i = await inspect(page);
  assert.ok(i.light.left <= 0 && i.light.top <= 0 && i.light.right >= i.W && i.light.bottom >= i.H, `${label}: la capa lumínica debe cubrir todo el viewport ${i.W}x${i.H}: ${JSON.stringify(i.light)}`);
  assert.deepEqual(i.covered, [], `${label}: puntos del viewport con otra cosa encima de la capa lumínica`);
  assert.deepEqual(i.ui, { ui: false, banner: false, debug: false, diag: false, enter: false, session: false, conn: false, label: false }, `${label}: ninguna interfaz visible en modo espectáculo`);
  assert.equal(i.lightBg, toCss(rgb), `${label}: color de la capa`); assert.equal(i.htmlBg, toCss(rgb), `${label}: fondo de <html>`); assert.equal(i.bodyBg, toCss(rgb), `${label}: fondo de <body>`);
  assert.equal(i.theme, hex.toLowerCase(), `${label}: theme-color`);
  assert.ok(i.scrollW <= i.W && i.scrollH <= i.H, `${label}: sin desbordamiento/scroll (${i.scrollW}x${i.scrollH} vs ${i.W}x${i.H})`);
  const img = decodePng(await page.screenshot({ type: 'png' }));
  assert.equal(img.width, Math.round(i.W * i.dpr)); assert.equal(img.height, Math.round(i.H * i.dpr));
  const bad = checkCoverage(img, rgb);
  assert.equal(bad.length, 0, `${label}: píxeles de borde/malla con color distinto: ${JSON.stringify(bad.slice(0, 5))}`);
  assert.equal(mismatchRatio(img, rgb), 0, `${label}: toda la captura debe ser el color pedido`);
}

test('COBERTURA (emulación): en cada perfil el color del Master cubre el 100 % del viewport, sin interfaz encima, y se cambia de color sin residuos', { skip, timeout: 240000 }, async t => {
  const { master, phone } = await setup(t);
  const errors = [];
  for (const prof of PROFILES) {
    const p = await phone(prof); p.on('pageerror', e => errors.push(e.message));
    // pantalla de incorporación: negro + interfaz visible (todavía no hay orden)
    let i = await inspect(p);
    assert.equal(i.ui.ui, true, `${prof.name}: la interfaz de incorporación es visible antes del espectáculo`); assert.equal(i.ui.enter, true);
    assert.equal(i.lightBg, 'rgb(0, 0, 0)', 'sin parpadeos: la capa arranca en negro');
    for (const hexc of ['#FF3B30', '#FFFFFF', '#0A84FF', '#34C759']) {
      master.send(color(hexc));
      assert.ok(await waitShown(p, hex2rgb(hexc)), `${prof.name}: ${hexc} aplicado`);
      assert.equal((await state(p)).mode, 'show', `${prof.name}: la primera orden activa el modo espectáculo`);
      await assertFullCoverage(p, hexc, `${prof.name} ${hexc}`);
    }
    // intensidad: color atenuado, también en toda la superficie
    master.send(color('#FFFFFF', { intensity: 0.5 })); assert.ok(await waitShown(p, [128, 128, 128], 4000, 2));
    await assertFullCoverage(p, '#808080', `${prof.name} intensidad 0,5`);
    // "apagado": negro total, sin interfaz
    master.send({ protocolVersion: 1, type: 'stop' }); assert.ok(await waitShown(p, [0, 0, 0]));
    await assertFullCoverage(p, '#000000', `${prof.name} DETENER`);
    await p.close();
  }
  assert.deepEqual(errors, [], 'sin errores de JavaScript');
});

test('COBERTURA: al girar el teléfono / cambiar el tamaño la superficie sigue cubierta y el efecto NO reinicia su fase', { skip, timeout: 120000 }, async t => {
  const { master, phone } = await setup(t);
  const p = await phone(PROFILES[0]);
  master.send({ protocolVersion: 1, type: 'command', leadMs: 300, payload: { effect: 'pulse', color: '#0A84FF', color2: '#000000', periodMs: 2000 } });
  await p.waitForFunction(() => window.DestelloRemote._state.mode === 'show', { timeout: 6000 });
  await sleep(1200);
  const before = await p.evaluate(() => ({ v: window.DestelloRemote._state.appliedMeta.version, applied: window.DestelloRemote._state.stats.applied, exec: window.DestelloRemote._state.current.executeAt }));
  const sizes = [[844, 390], [390, 844], [320, 568], [1024, 600], [390, 844]];
  for (const [w, h] of sizes) {
    await p.setViewport({ width: w, height: h, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: w > h });
    await sleep(200);
    const i = await inspect(p);
    assert.equal(i.W, w); assert.equal(i.H, h);
    assert.ok(i.light.left <= 0 && i.light.top <= 0 && i.light.right >= w && i.light.bottom >= h, `${w}x${h}: capa cubre el viewport`);
    assert.deepEqual(i.covered, [], `${w}x${h}: nada encima`);
    assert.deepEqual(Object.values(i.ui), Object.values(i.ui).map(() => false), `${w}x${h}: sin interfaz`);
    // el color mostrado es función del TIEMPO común: coincide con el motor evaluado ahora mismo (no se "reinició" por el cambio de tamaño)
    const cmp = await p.evaluate(() => { const S = window.DestelloRemote._state; const now = window.DestelloRemote._serverNow(); const r = window.DestelloEffects.evaluate(S.current, now, { from: S.from }).rgb.map(Math.round); return { r, shown: S.shown.map(Math.round) }; });
    assert.ok(cmp.shown.every((v, k) => Math.abs(v - cmp.r[k]) <= 30), `${w}x${h}: color mostrado ${cmp.shown} vs motor ${cmp.r}`);
  }
  const after = await p.evaluate(() => ({ v: window.DestelloRemote._state.appliedMeta.version, applied: window.DestelloRemote._state.stats.applied, exec: window.DestelloRemote._state.current.executeAt }));
  assert.deepEqual(after, before, 'los cambios de viewport no reaplicaron ni reiniciaron el estado');
});

test('MODO ESPECTÁCULO: entrada manual, primer toque pide pantalla completa, 5 toques abren el panel, salida segura y limpieza', { skip, timeout: 120000 }, async t => {
  const { master, phone, srv } = await setup(t);
  const p = await phone(PROFILES[0], { init: () => { window.__fs = { calls: 0 }; Element.prototype.requestFullscreen = function () { window.__fs.calls++; return Promise.resolve(); }; } });
  // sin orden todavía: el participante puede entrar con el botón (gesto válido para pantalla completa)
  assert.equal((await state(p)).mode, 'preshow');
  await p.click('#remote-enter');
  assert.equal((await state(p)).mode, 'show');
  assert.equal(await p.evaluate(() => window.__fs.calls), 1, 'el botón «Entrar al espectáculo» solicitó pantalla completa dentro del gesto');
  let i = await inspect(p); assert.equal(i.ui.ui, false, 'en modo espectáculo la interfaz desaparece también sin color activo (pantalla negra)');
  assert.deepEqual(i.covered, []);
  master.send(color('#FF9F1C')); assert.ok(await waitShown(p, hex2rgb('#FF9F1C')));
  // toques sueltos: no abren el panel
  for (let k = 0; k < 3; k++) { await p.mouse.click(100, 400); await sleep(60); }
  assert.equal((await state(p)).panel, false);
  // cinco seguidos abren el panel de diagnóstico con salida segura
  for (let k = 0; k < 3; k++) { await p.mouse.click(100, 400); await sleep(60); }     // el 6.º toque cae donde aparece un botón: debe ignorarse
  assert.equal((await state(p)).panel, true, 'el quinto toque abre el panel y el toque residual NO lo cierra ni pulsa un botón');
  i = await inspect(p); assert.equal(i.ui.ui, true); assert.equal(i.ui.diag, true);
  const diag = await p.$eval('#remote-diag', n => n.textContent);
  assert.match(diag, /Sesión [A-Z2-9]{6}/); assert.match(diag, /390×844 CSS px/); assert.match(diag, /Pantalla completa:/);
  // el panel no es parte del color: se cierra con «Volver» y la superficie queda limpia
  await sleep(800); await p.click('#remote-back');                                    // (los botones ignoran toques durante 700 ms tras abrir el panel)
  assert.equal((await state(p)).panel, false); assert.deepEqual((await inspect(p)).covered, []);
  // Esc abre/cierra el panel (escritorio/teclado)
  await p.keyboard.press('Escape'); assert.equal((await state(p)).panel, true);
  await p.keyboard.press('Escape'); assert.equal((await state(p)).panel, false);
  // autocierre del panel a los 10 s
  await p.keyboard.press('Escape'); assert.equal((await state(p)).panel, true);
  await p.waitForFunction(() => !window.DestelloRemote._state.panelOpen, { timeout: 12000 });
  // las órdenes siguen funcionando con el panel abierto o cerrado
  master.send(color('#AF52DE')); assert.ok(await waitShown(p, hex2rgb('#AF52DE')));
  // salida segura
  await p.keyboard.press('Escape'); await sleep(800);
  await p.click('#remote-exit'); assert.equal(await p.$eval('#remote-exit', n => n.textContent), 'Tocá de nuevo para salir', '«Salir» pide confirmación');
  assert.equal((await state(p)).mode, 'show'); await p.click('#remote-exit');
  await p.waitForFunction(() => !document.getElementById('remote-stage').classList.contains('active'));
  const out = await p.evaluate(() => ({ remoteOn: document.documentElement.classList.contains('remote-on'), showMode: document.documentElement.classList.contains('show-mode'), ended: document.getElementById('view-ended').classList.contains('active'), htmlBg: document.documentElement.style.backgroundColor }));
  assert.deepEqual(out, { remoteOn: false, showMode: false, ended: true, htmlBg: '' }, 'al salir se restaura la interfaz original y los fondos');
  await sleep(300); assert.equal(srv.app.hub.stats().public, 0, 'el dispositivo se desconectó del servidor');
});

test('PANTALLA COMPLETA: se gestionan aceptación, rechazo y ausencia de la API (simulación del comportamiento de Android/iOS)', { skip, timeout: 120000 }, async t => {
  const { phone, master } = await setup(t);
  // (1) rechazo por política del navegador (p. ej. sin gesto o iframe): no rompe nada y queda registrado
  const rej = await phone(PROFILES[2], { init: () => { Element.prototype.requestFullscreen = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })); } });
  await rej.click('#remote-enter'); await sleep(200);
  let st = await state(rej);
  assert.equal(st.mode, 'show'); assert.equal(st.fs.state, 'rejected'); assert.equal(st.fs.reason, 'NotAllowedError');
  assert.deepEqual((await inspect(rej)).covered, [], 'aun sin pantalla completa la superficie cubre el viewport disponible');
  // (2) iPhone/Safari: sin Fullscreen API en elementos -> no se presenta como solución; se muestra la instrucción honesta
  const ios = await phone(PROFILES[0], { init: () => { delete Element.prototype.requestFullscreen; delete Element.prototype.webkitRequestFullscreen; Element.prototype.requestFullscreen = undefined; } });
  const advice = await ios.$eval('#remote-advice', n => n.textContent);
  assert.match(advice, /Agregar a pantalla de inicio/); assert.match(advice, /barra de estado.*iOS/);
  st = await state(ios); assert.equal(st.fs.api, 'none');
  await ios.click('#remote-enter'); st = await state(ios); assert.equal(st.mode, 'show'); assert.equal(st.fs.requested, false, 'sin API no se intenta nada');
  master.send(color('#0A84FF')); assert.ok(await waitShown(ios, hex2rgb('#0A84FF')));
  await assertFullCoverage(ios, '#0A84FF', 'iPhone sin pantalla completa (emulación)');
  // (3) versión instalada (iOS standalone simulado): el consejo cambia y no se pide nada
  const inst = await phone(PROFILES[0], { init: () => { Object.defineProperty(navigator, 'standalone', { value: true }); } });
  assert.match(await inst.$eval('#remote-advice', n => n.textContent), /versión instalada/);
  // (4) Android: aceptación; cada gesto posterior no repite la solicitud mientras ya está activa
  master.send({ protocolVersion: 1, type: 'stop' }); await sleep(500);                  // la sesión vuelve a "apagado": el teléfono nuevo empieza en la pantalla de incorporación
  const ok = await phone(PROFILES[2], { init: () => { window.__c = 0; Element.prototype.requestFullscreen = function () { window.__c++; return Promise.resolve(); }; } });
  await ok.click('#remote-enter'); await sleep(100);
  assert.equal(await ok.evaluate(() => window.__c), 1);
  assert.equal((await state(ok)).fs.state, 'accepted');
});

test('INCORPORACIÓN: enlace sin código (app instalada) pide el código; validación; el QR con código entra directo; no queda interfaz de la app original', { skip, timeout: 90000 }, async t => {
  const { s, master, phone, srv } = await setup(t);
  const p = await phone(PROFILES[0], { url: `${srv.base}/?mode=remote`, connect: false });
  await p.waitForFunction(() => window.DestelloRemote && !document.getElementById('remote-join-form').hidden);
  const hiddenOriginal = await p.evaluate(() => ['.topbar', 'main.stage'].every(sel => getComputedStyle(document.querySelector(sel)).display === 'none'));
  assert.equal(hiddenOriginal, true, 'la interfaz de la app original (modo micrófono) no se ve en el modo remoto');
  assert.equal(await p.$eval('#remote-session', n => n.textContent), 'SIN SESIÓN');
  await p.type('#remote-code', 'AB3F9'); await p.click('#remote-join-form button[type=submit]');
  assert.equal(await p.$eval('#remote-code-error', n => !n.hidden), true, 'código inválido: mensaje claro');
  await p.$eval('#remote-code', n => { n.value = ''; });
  await p.type('#remote-code', s.sessionId.toLowerCase()); await p.click('#remote-join-form button[type=submit]');
  await p.waitForFunction(() => window.DestelloRemote._state.connected, { timeout: 8000 });
  assert.equal(new URL(p.url()).searchParams.get('s'), s.sessionId, 'la URL se actualiza para que recargar mantenga la sesión');
  master.send(color('#34C759')); assert.ok(await waitShown(p, hex2rgb('#34C759')));
  await assertFullCoverage(p, '#34C759', 'ingreso por código');
  // QR: el enlace original conserva su formato y entra directo (el script del <head> evita ver la app original)
  const q = await phone(PROFILES[2]);
  assert.equal(await q.evaluate(() => document.documentElement.classList.contains('remote-on')), true);
  assert.equal((await state(q)).connected, true);
});

test('RECONEXIÓN: el modo se conserva, no reaparece un color obsoleto y el aviso de desconexión solo aparece tras 10 s', { skip, timeout: 120000 }, async t => {
  const { master, phone, srv } = await setup(t);
  const p = await phone(PROFILES[0], { init: () => {
    const Native = window.WebSocket; window.__block = false; window.__sockets = [];
    window.WebSocket = class extends Native { constructor(u) { if (window.__block) { super('ws://127.0.0.1:1/'); } else super(u); window.__sockets.push(this); } };
  } });
  master.send(color('#FF3B30')); assert.ok(await waitShown(p, hex2rgb('#FF3B30')));
  // corte con reconexión bloqueada: durante los primeros segundos NO se ve ningún aviso sobre el color
  await p.evaluate(() => { window.__block = true; window.__sockets[window.__sockets.length - 1].close(); });
  await p.waitForFunction(() => !window.DestelloRemote._state.connected, { timeout: 4000 });
  await sleep(3000);
  let i = await inspect(p);
  assert.equal(i.ui.banner, false, 'sin aviso a los 3 s de corte'); assert.deepEqual(i.covered, []);
  assert.equal((await state(p)).mode, 'show');
  // el operador cambia de color mientras el teléfono no tiene conexión
  master.send(color('#0A84FF'));
  await p.waitForFunction(() => { const b = document.getElementById('remote-banner'); return !b.hidden; }, { timeout: 12000 });
  i = await inspect(p);
  assert.equal(i.ui.banner, true, 'tras >10 s sin conexión aparece la pastilla mínima');
  const pill = await p.evaluate(() => { const r = document.getElementById('remote-banner').getBoundingClientRect(); return { h: r.height, areaPct: (r.width * r.height) / (innerWidth * innerHeight) * 100, compact: document.getElementById('remote-banner').classList.contains('compact') }; });
  assert.ok(pill.compact && pill.areaPct < 5, `aviso compacto (${pill.areaPct.toFixed(2)} % de la pantalla)`);
  assert.deepEqual((await state(p)).shown, [255, 59, 48], 'sigue mostrando el último color mientras no hay conexión (congelado, no apagado)');
  // vuelve la conexión: nunca se vuelve a ver el color viejo una vez mostrado el nuevo
  await p.evaluate(() => { window.__block = false; window.dispatchEvent(new Event('online')); });      // vuelve la red: el navegador emite "online" y el cliente reconecta con jitter corto
  const seen = []; const t0 = Date.now();
  while (Date.now() - t0 < 20000) { const s = await state(p); if (s.connected || seen.length) seen.push(s.shown.join(',')); if (s.connected && s.shown.join(',') === '10,132,255') break; await sleep(40); }
  const idxNew = seen.indexOf('10,132,255'); assert.ok(idxNew >= 0, 'se mostró el estado vigente tras reconectar');
  assert.ok(!seen.slice(idxNew).includes('255,59,48'), 'el color obsoleto no reaparece después del vigente');
  await p.waitForFunction(() => document.getElementById('remote-banner').hidden, { timeout: 4000 });
  assert.equal((await state(p)).mode, 'show', 'el modo espectáculo se conserva tras la reconexión');
  await assertFullCoverage(p, '#0A84FF', 'tras reconexión');
  assert.equal(srv.app.hub.stats().public, 1);
});

test('EFECTOS (emulación): pulso/transición/strobe pintan toda la capa; movimiento reducido los vuelve color fijo; el strobe respeta 3 Hz', { skip, timeout: 120000 }, async t => {
  const { master, phone } = await setup(t);
  const p = await phone(PROFILES[2]);
  master.send({ protocolVersion: 1, type: 'command', leadMs: 300, payload: { effect: 'fade', color: '#FF0000', color2: '#0000FF', fadeMs: 1500 } });
  await p.waitForFunction(() => window.DestelloRemote._state.mode === 'show', { timeout: 5000 });
  await sleep(700); let mid = (await state(p)).shown; assert.ok(mid[0] > 20 && mid[2] > 20, `a mitad de la transición hay mezcla: ${mid}`);
  assert.deepEqual((await inspect(p)).covered, []);
  await sleep(1200); assert.deepEqual((await state(p)).shown, [0, 0, 255], 'la transición termina exactamente en el segundo color');
  await assertFullCoverage(p, '#0000FF', 'fin de transición');
  // strobe: máximo 3 Hz medidos sobre lo realmente pintado
  master.send({ protocolVersion: 1, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: true }); await master.waitFor('config');
  master.send({ protocolVersion: 1, type: 'command', leadMs: 300, payload: { effect: 'strobe', color: '#FFFFFF', hz: 3, duty: 0.4, durationMs: 4000 } });
  await sleep(900);
  const samples = []; const t0 = Date.now(); while (Date.now() - t0 < 2000) { samples.push((await state(p)).shown[0] > 128); await sleep(8); }
  let flashes = 0; samples.forEach((on, k) => { if (on && !samples[k - 1]) flashes++; });
  assert.ok(flashes >= 4 && flashes <= 7, `destellos en 2 s: ${flashes} (3 Hz → ~6)`);
  assert.deepEqual((await inspect(p)).covered, [], 'el strobe también se pinta sobre toda la capa');
  // movimiento reducido: el strobe/pulso se muestran como color fijo
  await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const p2 = await phone(PROFILES[2]); await p2.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await p2.reload(); await p2.waitForFunction(() => window.DestelloRemote._state.connected, { timeout: 8000 });
  master.send({ protocolVersion: 1, type: 'command', leadMs: 300, payload: { effect: 'strobe', color: '#FF0000', hz: 3, durationMs: 4000 } });
  await sleep(1200);
  const calm = []; for (let k = 0; k < 15; k++) { calm.push((await state(p2)).shown.join(',')); await sleep(60); }
  assert.deepEqual([...new Set(calm)], ['255,0,0'], 'con movimiento reducido el strobe es un color fijo');
});

test('SINCRONIZACIÓN conservada tras los cambios visuales: 4 teléfonos aplican dentro de 60 ms del instante programado (mismo reloj; emulación)', { skip, timeout: 120000 }, async t => {
  const { master, phone } = await setup(t);
  const phones = []; for (let k = 0; k < 4; k++) phones.push(await phone(PROFILES[k % 3]));
  await sleep(2500);
  master.send(color('#FFD400', {}, 1500)); const ack = await master.waitFor('ack');
  await Promise.all(phones.map(p => waitShown(p, hex2rgb('#FFD400'), 6000)));
  const devs = []; for (const p of phones) devs.push((await p.evaluate(() => window.DestelloRemote._state.appliedMeta.wallAt)) - ack.executeAt);
  console.log('# desviación real (ms) con los cambios visuales:', devs.map(Math.round).join(', '));
  assert.ok(devs.every(d => Math.abs(d) <= 60), `desviaciones: ${devs}`);
  // los ACK siguen siendo "aceptada", no fotometría: el servidor distingue aceptada/aplicada
  assert.equal(ack.type, 'ack'); assert.ok(ack.stateVersion >= 1);
});

test('CPU: en modo espectáculo con color fijo el hilo principal queda ocioso; pulso y strobe cuestan una fracción medida', { skip, timeout: 120000 }, async t => {
  const { master, phone } = await setup(t);
  const p = await phone(PROFILES[2]);
  const cdp = await p.createCDPSession(); await cdp.send('Performance.enable');
  const metric = async name => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === name).value;
  async function busy(ms) { const a = await metric('TaskDuration'); await sleep(ms); return ((await metric('TaskDuration')) - a) / (ms / 1000) * 100; }   // % de un núcleo
  master.send(color('#FF3B30')); await waitShown(p, [255, 59, 48]); await sleep(800);
  const fixed = await busy(3000);
  master.send({ protocolVersion: 1, type: 'command', leadMs: 300, payload: { effect: 'pulse', color: '#0A84FF', periodMs: 2000 } }); await sleep(900);
  const pulse = await busy(3000);
  master.send({ protocolVersion: 1, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: true }); await master.waitFor('config');
  master.send({ protocolVersion: 1, type: 'command', leadMs: 300, payload: { effect: 'strobe', color: '#FFFFFF', hz: 3, durationMs: 8000 } }); await sleep(900);
  const strobe = await busy(3000);
  console.log(`# uso de CPU del hilo principal (Chrome de escritorio, emulación; NO es un teléfono de gama baja): fijo ${fixed.toFixed(1)} % · pulso ${pulse.toFixed(1)} % · strobe ${strobe.toFixed(1)} %`);
  assert.ok(fixed < 3, `color fijo: ${fixed}%`); assert.ok(pulse < 25, `pulso: ${pulse}%`); assert.ok(strobe < 40, `strobe: ${strobe}%`);
});
