'use strict';
// E2E en Chrome REAL: «Salir» y «Salir en todos» del panel Master revocan el token EN EL SERVIDOR (no solo lo olvidan en el navegador), el panel funciona bajo la
// CSP real y las cabeceras de seguridad llegan al navegador.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, PASSWORD, http, sleep } = require('../test/helpers');

const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
const skip = CHROME ? false : 'No hay Chrome/Edge: CHROME_PATH';

async function openPanel(browser, base, errors) {
  const page = await (await browser.createBrowserContext()).newPage();
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/master'); await page.type('#password', PASSWORD); await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#create', { visible: true });
  return page;
}
const tokenOf = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('ds-op')).token);

test('E2E panel: «Salir» revoca el token del operador en el servidor; «Salir en todos» invalida también los de otros navegadores; sin errores de CSP', { skip, timeout: 90000 }, async t => {
  const srv = await startServer(); t.after(srv.stop);
  const puppeteer = require('puppeteer-core'); const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const errors = []; const A = await openPanel(browser, srv.base, errors); const B = await openPanel(browser, srv.base, errors);
  const tokA = await tokenOf(A); const tokB = await tokenOf(B);
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: tokA })).status, 200); assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: tokB })).status, 200);
  // cabeceras que el navegador recibió
  const resp = await A.evaluate(async () => { const r = await fetch('/master'); return { corp: r.headers.get('cross-origin-resource-policy'), csp: r.headers.get('content-security-policy'), xfo: r.headers.get('x-frame-options') }; });
  assert.equal(resp.corp, 'same-origin'); assert.equal(resp.xfo, 'DENY'); assert.match(resp.csp, /frame-ancestors 'none'/);

  await A.click('#logout'); await A.waitForSelector('#loginView', { visible: true });
  await sleep(300);
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: tokA })).status, 401, 'el token que se «olvidó» en el navegador ya no vale en el servidor');
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: tokB })).status, 200, 'el de otro navegador sigue valiendo');
  assert.equal(await A.evaluate(() => sessionStorage.getItem('ds-op')), null);

  B.on('dialog', d => d.accept()); await B.click('#logoutAll'); await B.waitForSelector('#loginView', { visible: true }); await sleep(300);
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: tokB })).status, 401);
  // volver a ingresar funciona (la generación nueva vale)
  await A.type('#password', PASSWORD); await A.click('#loginForm button[type=submit]'); await A.waitForSelector('#create', { visible: true });
  assert.equal((await http(srv.base, 'GET', '/api/sessions', { token: await tokenOf(A) })).status, 200);
  assert.deepEqual(errors, [], 'sin errores de CSP ni de script en el panel');
});
