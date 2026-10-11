'use strict';
// Plataforma y cobertura: lógica de Android/iOS con entornos SIMULADOS (no prueban Safari real) + activos estáticos de la PWA y metadatos del documento.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../public/js/platform');
const FX = require('../public/js/effects');
const { startServer } = require('./helpers');
const { decodePng } = require('./png');

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
};
const win = (modes = {}) => ({ matchMedia: q => ({ matches: Boolean(modes[q]) }) });

test('detect: iPhone/Safari, iPhone/Chrome, Android/Chrome, iPad (que se identifica como Mac) y modos instalados', () => {
  const a = P.detect({ userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5 }, win());
  assert.deepEqual([a.ios, a.iphone, a.android, a.safari, a.displayMode, a.installed], [true, true, false, true, 'browser', false]);
  assert.equal(P.detect({ userAgent: UA.iphoneChrome }, win()).safari, false, 'Chrome en iOS no es Safari (sigue siendo WebKit)');
  const d = P.detect({ userAgent: UA.android, maxTouchPoints: 5 }, win());
  assert.deepEqual([d.android, d.ios, d.displayMode], [true, false, 'browser']);
  const ipad = P.detect({ userAgent: UA.ipad, platform: 'MacIntel', maxTouchPoints: 5 }, win());
  assert.deepEqual([ipad.ipad, ipad.ios, ipad.iphone], [true, true, false]);
  assert.equal(P.detect({ userAgent: UA.iphone, standalone: true }, win()).displayMode, 'standalone', 'iOS instalada: navigator.standalone');
  assert.equal(P.detect({ userAgent: UA.android }, win({ '(display-mode: standalone)': true })).displayMode, 'standalone');
  assert.equal(P.detect({ userAgent: UA.android }, win({ '(display-mode: fullscreen)': true })).displayMode, 'fullscreen');
  assert.equal(P.detect({ userAgent: UA.android }, win({ '(display-mode: fullscreen)': true })).installed, true);
  assert.equal(P.detect({ userAgent: 'x' }, {}).displayMode, 'browser', 'sin matchMedia no se rompe');
});

const docWith = el => ({ documentElement: el });
test('requestFullscreen: Android/Chrome (promesa resuelta) y rechazo (sin gesto) se informan sin lanzar', async () => {
  let called = null;
  const ok = docWith({ requestFullscreen: o => { called = o; return Promise.resolve(); } });
  assert.deepEqual(await P.requestFullscreen(ok), { ok: true, api: 'standard' });
  assert.deepEqual(called, { navigationUI: 'hide' }, 'pide ocultar la interfaz de navegación');
  const rej = docWith({ requestFullscreen: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) });
  assert.deepEqual(await P.requestFullscreen(rej), { ok: false, api: 'standard', reason: 'NotAllowedError' });
  const thr = docWith({ requestFullscreen: () => { throw Object.assign(new Error('x'), { name: 'TypeError' }); } });
  assert.equal((await P.requestFullscreen(thr)).reason, 'TypeError');
});

test('requestFullscreen: WebKit con prefijo (síncrono, sin promesa) y iPhone/Safari (sin API): no se presenta como solución universal', async () => {
  const wk = docWith({ webkitRequestFullscreen: () => undefined });
  assert.deepEqual(await P.requestFullscreen(wk), { ok: true, api: 'webkit', sync: true });
  const iphone = docWith({});                                   // iPhone/Safari: ni requestFullscreen ni webkitRequestFullscreen en elementos
  assert.equal(P.fullscreenApi(iphone), 'none');
  assert.deepEqual(await P.requestFullscreen(iphone), { ok: false, api: 'none', reason: 'unsupported' });
  assert.equal(P.fullscreenApi(docWith({ msRequestFullscreen() {} })), 'ms');
});

test('advice: cada plataforma recibe una instrucción distinta y honesta (sin prometer ocultar la barra de estado de iOS)', () => {
  const iphone = P.advice({ iphone: true, ios: true, installed: false }, 'none');
  assert.equal(iphone.key, 'ios-iphone');
  assert.match(iphone.text, /Agregar a pantalla de inicio/); assert.match(iphone.text, /Ocultar barra de herramientas/); assert.match(iphone.text, /barra de estado.*iOS/);
  assert.equal(P.advice({ ios: true, ipad: true, installed: false }, 'webkit').key, 'ios-ipad');
  assert.equal(P.advice({ android: true, installed: false }, 'standard').key, 'fullscreen');
  assert.equal(P.advice({ android: true, installed: false }, 'none').key, 'no-fullscreen');
  assert.equal(P.advice({ iphone: true, ios: true, installed: true }, 'none').key, 'installed');
});

test('normalizeCode y toHex', () => {
  assert.equal(P.normalizeCode(' ab3f9k '), 'AB3F9K'); assert.equal(P.normalizeCode('AB3F9'), null);
  assert.equal(P.normalizeCode('AB3F9I'), null, 'I no está en el alfabeto'); assert.equal(P.normalizeCode('A0B1C2'), null); assert.equal(P.normalizeCode(null), null);
  assert.equal(P.toHex([255, 59, 48]), '#ff3b30'); assert.equal(P.toHex([0, 0, 0]), '#000000'); assert.equal(P.toHex([300, -5, 12.6]), '#ff000d');
});

// ------------------------------------------------------------------ activos estáticos, metadatos y CSP (servidor real)
test('index.html: metadatos de cobertura total, iOS standalone y bloqueo de "force dark"', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const html = await (await fetch(srv.base + '/?mode=remote')).text();
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.match(html, /<meta name="theme-color" content="#000000"/);
  assert.match(html, /<meta name="color-scheme" content="dark"/);
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /<meta name="mobile-web-app-capable" content="yes"/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  assert.match(html, /<script src="\/js\/platform\.js"><\/script>/);
  assert.ok(html.indexOf('/js/platform.js') < html.indexOf('/js/remote.js'), 'platform.js se carga antes que remote.js');
  // CSS de la capa lumínica: sin márgenes, con sangrado y sin áreas seguras en el fondo
  const css = html.match(/\.remote-light \{[^}]*\}/)[0];
  assert.match(css, /top: -1px; right: -1px; bottom: -1px; left: -1px/); assert.match(css, /100lvh/); assert.ok(!/env\(safe-area/.test(css), 'las áreas seguras NO se aplican al fondo lumínico');
  const stage = html.match(/\.remote-stage \{[^}]*\}/)[0];
  assert.match(stage, /padding: 0/); assert.match(stage, /margin: 0/); assert.ok(!/env\(safe-area/.test(stage));
  assert.match(html, /html\.remote-on \.topbar[^}]*display: none !important/, 'la interfaz de la app original se oculta en el modo remoto');
  assert.ok(html.includes('id="remote-light"') && html.includes('id="remote-ui"'), 'capa lumínica separada de la capa de interfaz');
  assert.ok(html.indexOf('id="remote-light"') < html.indexOf('id="remote-ui"'), 'la interfaz va por encima de la capa lumínica en el DOM');
  // el script del <head> que marca el modo remoto antes del primer pintado está autorizado por hash en la CSP (sin unsafe-inline)
  const res = await fetch(srv.base + '/?mode=remote'); const csp = res.headers.get('content-security-policy');
  assert.match(csp, /manifest-src 'self'/); assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
});

test('manifest.webmanifest: instalable en pantalla completa, con íconos PNG válidos y el tipo MIME correcto', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const res = await fetch(srv.base + '/manifest.webmanifest');
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
  const m = await res.json();
  assert.equal(m.display, 'fullscreen'); assert.deepEqual(m.display_override, ['fullscreen', 'standalone']);
  assert.equal(m.start_url, '/?mode=remote'); assert.equal(m.scope, '/'); assert.equal(m.orientation, 'any');
  assert.equal(m.background_color, '#000000'); assert.equal(m.theme_color, '#000000');
  assert.ok(m.icons.some(i => i.sizes === '192x192') && m.icons.some(i => i.sizes === '512x512') && m.icons.some(i => i.purpose === 'maskable'));
  for (const ic of [...m.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
    const r = await fetch(srv.base + ic.src); assert.equal(r.status, 200, ic.src); assert.equal(r.headers.get('content-type'), 'image/png');
    const img = decodePng(Buffer.from(await r.arrayBuffer())); assert.equal(`${img.width}x${img.height}`, ic.sizes, ic.src);
  }
});

test('el QR y el enlace de unión conservan el formato original /?s=CODIGO&mode=remote', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const { login, createSession } = require('./helpers');
  const s = await createSession(srv.base, await login(srv.base));
  assert.match(s.joinUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?s=[A-HJ-NP-Z2-9]{6}&mode=remote$/);
});
