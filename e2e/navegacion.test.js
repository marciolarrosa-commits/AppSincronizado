'use strict';
// E2E en Chrome/Edge REAL del flujo de navegación: portada -> panel -> login -> crear sesión -> QR -> participante, y el interruptor de la app Flash.
// Es un navegador de escritorio (no un iPhone/Android físico). Se omite si no hay navegador (CHROME_PATH).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, PASSWORD, sleep } = require('../test/helpers');

const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
const skip = CHROME ? false : 'No hay Chrome/Edge: CHROME_PATH';

test('E2E navegación: / -> «Abrir panel del operador» -> login -> sesión con QR -> el participante conecta; Flash habilitable con su propio QR', { skip, timeout: 90000 }, async t => {
  const srv = await startServer({ wsConnectPerMinPerIp: 100000, httpPerMin: 100000 }); t.after(srv.stop);
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await (await browser.createBrowserContext()).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  // 1) la raíz es la presentación nueva y su botón lleva al panel (sin pasar por la app anterior)
  await page.goto(srv.base + '/');
  assert.ok((await page.$eval('h1', n => n.textContent)).includes('pantallas del público'));
  assert.equal(await page.$('#btn-create'), null, 'no existe el botón «Crear sesión» de la app anterior');
  await Promise.all([page.waitForNavigation(), page.click('#open-master')]);
  assert.equal(new URL(page.url()).pathname, '/master');

  // 2) login, crear sesión real, código + QR
  await page.type('#password', PASSWORD);
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#create', { visible: true });
  await page.waitForSelector('#flashCard', { visible: true });
  await page.click('#create');
  await page.waitForFunction(() => document.getElementById('code').textContent.length === 6 && /online/.test(document.getElementById('status').textContent), { timeout: 8000 });
  const joinUrl = await page.$eval('#url', n => n.textContent);
  assert.match(joinUrl, /\/\?s=[A-Z0-9]{6}&mode=remote$/);
  assert.ok(await page.$('#qr canvas, #qr img, #qr table'), 'se dibuja el QR de la sesión');

  // 3) un participante abre el enlace del QR (sin login) y se conecta
  const phone = await (await browser.createBrowserContext()).newPage();
  await phone.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await phone.goto(joinUrl + '&debug=1');
  await phone.waitForFunction(() => document.getElementById('remote-connection') && /CONECTADO/.test(document.getElementById('remote-connection').textContent), { timeout: 8000 });
  assert.ok(await phone.$eval('html', n => n.classList.contains('remote-on')), 'el participante ve solo la pantalla controlada por el operador (la interfaz de la app anterior queda oculta)');

  // 4) Flash: deshabilitada -> /flash da 403; el panel la habilita y muestra un QR propio; el público entra; se deshabilita y vuelve el 403
  assert.equal((await fetch(srv.base + '/flash')).status, 403);
  assert.match(await page.$eval('#flashState', n => n.textContent), /deshabilitada/);
  await page.click('#flashToggle');
  await page.waitForFunction(() => /HABILITADA/.test(document.getElementById('flashState').textContent), { timeout: 5000 });
  const flashUrl = await page.$eval('#flashUrl', n => n.textContent);
  assert.match(flashUrl, /\/flash\?s=[A-HJ-NP-Z2-9]{6}$/);
  assert.notEqual(flashUrl, joinUrl, 'el QR de Flash es distinto del QR de la sesión');
  assert.ok(await page.$('#flashQr canvas, #flashQr img, #flashQr table'), 'se dibuja el QR de Flash');
  const flashPage = await (await browser.createBrowserContext()).newPage();
  await flashPage.goto(flashUrl);
  await flashPage.waitForSelector('#view-activate.active', { timeout: 5000 });          // con código en el enlace la app Flash abre la vista de activación
  assert.ok((await flashPage.$eval('#activate-code-label', n => n.textContent)).includes(new URL(flashUrl).searchParams.get('s')));
  // la sesión V3 sigue conectada mientras tanto
  assert.match(await page.$eval('#status', n => n.textContent), /online/);
  await page.click('#flashToggle');
  await page.waitForFunction(() => /deshabilitada/.test(document.getElementById('flashState').textContent), { timeout: 5000 });
  assert.equal((await fetch(flashUrl)).status, 403);
  assert.deepEqual(errors, [], 'sin errores de JavaScript en portada ni panel');
});
