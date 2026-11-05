'use strict';
// E2E en Chrome REAL (V4.0): sección «Eventos» del panel Master + teléfono que entra por el QR /e/CODIGO. Se omite si no hay navegador.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, PASSWORD, http, login, sleep } = require('../test/helpers');

const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
const skip = CHROME ? false : 'No hay Chrome/Edge: CHROME_PATH';
const rgb = str => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(str); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };

test('E2E navegador: crear evento, QR PNG/SVG, activar, operar con nombre visible y efectos del evento, teléfono por /e/CODIGO y cierre definitivo', { skip, timeout: 120000 }, async t => {
  const srv = await startServer({ strobeAllowed: false }); t.after(srv.stop);
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const errors = [];
  const page = await (await browser.createBrowserContext()).newPage();
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const dialogs = []; page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(d.type() === 'prompt' ? (d.message().startsWith('Nombre') ? 'Recibimiento del Papa' : d.defaultValue()) : undefined); });

  await page.goto(srv.base + '/master'); await page.type('#password', PASSWORD); await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#eventsView', { visible: true });
  await page.waitForFunction(() => document.getElementById('dTotal').textContent === '0', { timeout: 8000 });

  // crear evento desde la interfaz
  await page.click('#evNew');
  await page.waitForSelector('#evDetail', { visible: true });
  assert.equal(await page.$eval('#evName', n => n.textContent), 'Recibimiento del Papa');
  const code = await page.$eval('#evCode', n => n.textContent); assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(await page.$eval('#evUrl', n => n.textContent), `${srv.base}/e/${code}`);
  assert.ok(await page.$('#evQr canvas, #evQr img'), 'el QR se dibuja');

  // QR descargable en PNG y SVG (se obtienen del mismo generador que usa el botón)
  const exp = await page.evaluate(async () => {
    const links = []; const blobs = []; const orig = HTMLAnchorElement.prototype.click; const origUrl = URL.createObjectURL;
    HTMLAnchorElement.prototype.click = function () { links.push({ name: this.download, href: this.href }); };
    URL.createObjectURL = function (b) { blobs.push(b); return origUrl.call(URL, b); };
    document.getElementById('evPng').click(); document.getElementById('evSvg').click();
    HTMLAnchorElement.prototype.click = orig; URL.createObjectURL = origUrl;
    const svgText = await blobs[0].text();
    return { png: links[0].name, pngHref: links[0].href.slice(0, 22), svg: links[1].name, svgHead: svgText.slice(0, 40), svgPath: /<path d="M/.test(svgText) };
  });
  assert.match(exp.png, /^qr-Recibimiento_del_Papa-[A-Z0-9]{6}\.png$/); assert.equal(exp.pngHref, 'data:image/png;base64,');
  assert.match(exp.svg, /\.svg$/); assert.match(exp.svgHead, /^<svg xmlns=/); assert.ok(exp.svgPath);
  await page.click('#evBig'); await page.waitForSelector('#qrBig', { visible: true }); assert.equal(await page.$eval('#qrBigCode', n => n.textContent), code); await page.click('#qrBigClose');

  // limitar efectos desde la interfaz: solo fijo y secuencia, con una secuencia propia
  await page.$eval('#fSeq', n => { n.value = 'Bandera: #0000FF 1, #FFFFFF 1 | transición 200 ms'; n.dispatchEvent(new Event('input')); });
  await page.$$eval('#fEffects input', is => is.forEach(i => { i.checked = ['solid', 'sequence'].includes(i.value); }));
  await page.click('#fSave'); await page.waitForFunction(() => /Guardado/.test(document.getElementById('fMsg').textContent), { timeout: 5000 });

  // activar: antes de la acción crítica se muestra el nombre del evento
  const clickBtn = label => page.evaluate(l => { const b = [...document.querySelectorAll('#evActions button')].find(x => x.textContent === l); if (!b) throw new Error('sin botón ' + l); b.click(); }, label);   // el detalle se repinta al refrescar: se hace clic en el mismo instante
  await clickBtn('Activar');
  await page.waitForFunction(() => document.getElementById('evStatus').textContent === 'Activo', { timeout: 5000 });
  assert.ok(dialogs.some(d => d.includes('«Recibimiento del Papa»') && d.includes('ACTIVAR')), 'la confirmación nombra el evento: ' + JSON.stringify(dialogs));

  // un teléfono entra por el QR del evento
  const phone = await (await browser.createBrowserContext()).newPage();
  await phone.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  const perr = []; phone.on('pageerror', e => perr.push(e.message));
  await phone.goto(`${srv.base}/e/${code}?debug=1`);
  await phone.waitForFunction(() => document.getElementById('remote-connection') && /CONECTADO/.test(document.getElementById('remote-connection').textContent), { timeout: 8000 });

  // operar: el nombre del evento queda visible, solo hay los efectos del evento y la paleta/secuencias son las suyas
  await clickBtn('Operar este evento');
  await page.waitForFunction(() => /online/.test(document.getElementById('status').textContent), { timeout: 8000 });
  assert.equal(await page.$eval('#ebName', n => n.textContent), 'Recibimiento del Papa');
  assert.match(await page.$eval('#stop', n => n.textContent), /«Recibimiento del Papa»/);
  const visible = await page.$$eval('[data-effect]', bs => bs.filter(b => !b.classList.contains('hidden')).map(b => b.getAttribute('data-effect')));
  assert.deepEqual(visible, ['solid', 'sequence']);
  assert.equal(await page.$$eval('#seqPresets button', bs => bs.length), 1);
  await page.click('#colors .color:nth-child(3)');                    // el color 3 de la paleta del evento (rojo por defecto)
  await page.click('#send');
  const end = Date.now() + 6000; let seen = false;
  while (Date.now() < end && !seen) { const c = rgb(await phone.$eval('#remote-stage', n => getComputedStyle(n).backgroundColor)); seen = c && c[0] > 200 && c[1] < 90; if (!seen) await sleep(50); }
  assert.ok(seen, 'el teléfono del evento muestra el color enviado desde el panel');

  // finalizar desde el panel de eventos: el teléfono recibe el cierre definitivo y no reintenta; el panel vuelve a la lista
  await page.click('#ebBack'); await page.waitForSelector('#eventsView', { visible: true });
  await page.waitForSelector('#evList .evrow button', { visible: true }); await page.evaluate(() => document.querySelector('#evList .evrow button').click());
  await page.waitForFunction(() => document.getElementById('evStatus').textContent === 'Activo');
  await clickBtn('Finalizar');
  await page.waitForFunction(() => document.getElementById('evStatus').textContent === 'Finalizado', { timeout: 5000 });
  await phone.waitForFunction(() => /EVENTO FINALIZADO/.test(document.getElementById('remote-connection').textContent), { timeout: 8000 });
  assert.equal((await http(srv.base, 'GET', `/api/sessions/${code}/status`)).status, 404);

  assert.deepEqual(errors, [], 'sin errores de JavaScript ni de CSP en el panel: ' + errors.join(' | '));
  assert.deepEqual(perr, [], 'sin errores en el teléfono');
});
