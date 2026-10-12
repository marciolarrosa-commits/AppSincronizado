'use strict';
// E2E en Chrome REAL: la página de calibración de color (/colores) se ejecuta bajo la CSP real (script por hash), dibuja los parches con los valores exactos
// y el campo completo pinta el color pedido en toda la pantalla.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('../test/helpers');

const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
const skip = CHROME ? false : 'No hay Chrome/Edge: CHROME_PATH';

test('E2E /colores: parches exactos, campo completo en pantalla completa y entorno informado, sin errores de CSP ni de script', { skip, timeout: 60000 }, async t => {
  const srv = await startServer(); t.after(srv.stop);
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(srv.base + '/colores');
  await page.waitForFunction(() => document.querySelectorAll('.sw').length >= 20 && !/Leyendo/.test(document.getElementById('env').textContent), { timeout: 5000 });
  const bg = await page.evaluate(() => [...document.querySelectorAll('#yel .sw .c')].map(c => getComputedStyle(c).backgroundColor));
  assert.deepEqual(bg, ['rgb(255, 212, 0)', 'rgb(255, 230, 0)', 'rgb(255, 240, 0)', 'rgb(255, 255, 0)', 'rgb(255, 159, 28)']);
  const ramp = await page.evaluate(() => [...document.querySelectorAll('#ramp .sw .c')].map(c => getComputedStyle(c).backgroundColor));
  assert.equal(ramp[0], 'rgb(255, 255, 255)'); assert.ok(ramp.every((c, i) => i === 0 || Number(c.match(/\d+/)[0]) < Number(ramp[i - 1].match(/\d+/)[0])), 'la escala baja de forma monótona: ' + ramp);
  assert.equal(ramp[4], 'rgb(203, 203, 203)', 'blanco al 60 % de luz lineal = sRGB 203');
  assert.match(await page.$eval('#env', e => e.textContent), /Gama: .*\nHDR/);
  await page.click('#fulls .sw');                                                       // primer campo: blanco
  const full = await page.$eval('#full', e => { const r = e.getBoundingClientRect(); return { on: e.classList.contains('on'), w: Math.round(r.width), h: Math.round(r.height), bg: getComputedStyle(e).backgroundColor }; });
  assert.deepEqual(full, { on: true, w: 390, h: 780, bg: 'rgb(255, 255, 255)' });
  await page.click('#full'); assert.equal(await page.$eval('#full', e => e.classList.contains('on')), false, 'tocar sale del campo completo');
  assert.deepEqual(errors, [], 'sin errores de CSP ni de script');
});
