'use strict';
// E2E en Chrome/Edge REAL (escritorio): el panel /master REAL arma una SECUENCIA de colores (color inicial + «＋» para agregar, segundos por color) y tres
// teléfonos REALES (remote.js + effects.js) la muestran en sincronía, ininterrumpida, hasta DETENER TODO. No es un Samsung/iPhone físico.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, PASSWORD, sleep } = require('../test/helpers');

const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
const skip = CHROME ? false : 'No hay Chrome/Edge: CHROME_PATH';

const rgb = s => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s); return m ? [+m[1], +m[2], +m[3]] : null; };
const PALETA = { R: [255, 0, 0], G: [0, 255, 0], B: [0, 0, 255], K: [0, 0, 0] };
const clasificar = c => { let best = '?', d = 60; for (const [k, v] of Object.entries(PALETA)) { const x = Math.abs(c[0] - v[0]) + Math.abs(c[1] - v[1]) + Math.abs(c[2] - v[2]); if (x < d) { d = x; best = k; } } return best; };

async function openMaster(browser, base) {
  const page = await (await browser.createBrowserContext()).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/master'); await page.type('#password', PASSWORD); await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#create', { visible: true }); await page.click('#create');
  await page.waitForFunction(() => document.getElementById('code').textContent.length === 6 && /online/.test(document.getElementById('status').textContent), { timeout: 8000 });
  return { page, errors, joinUrl: await page.$eval('#url', n => n.textContent) };
}
async function openPhone(browser, joinUrl, { reduced = false, effectsOff = false } = {}) {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  if (effectsOff) await page.evaluateOnNewDocument(() => localStorage.setItem('destello-effects-off', '1'));
  await page.goto(joinUrl);
  await page.waitForFunction(() => document.getElementById('remote-connection') && /CONECTADO/.test(document.getElementById('remote-connection').textContent), { timeout: 8000 });
  return page;
}
const color = page => page.$eval('#remote-stage', n => getComputedStyle(n).backgroundColor).then(rgb).then(clasificar);
const filas = page => page.$$eval('#seqList li', l => l.length);
const setInput = (page, sel, value) => page.$eval(sel, (n, v) => { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); }, value);
const rowSel = (i, kind) => `#seqList li:nth-child(${i}) input[type=${kind}]`;
const waitK = (page, re, timeout = 6000) => page.waitForFunction(r => new RegExp(r).test(document.getElementById('kAccepted').textContent), { timeout }, re.source);

test('E2E secuencia: lista editable con «＋», 2–12 colores, paleta por fila, y 3 teléfonos la muestran en sincronía, sin parar, hasta DETENER TODO', { skip, timeout: 120000 }, async t => {
  const srv = await startServer({ wsConnectPerMinPerIp: 1e6, httpPerMin: 1e6 }); t.after(srv.stop);
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] }); t.after(() => browser.close());
  const m = await openMaster(browser, srv.base); const page = m.page;

  // --- editor: color inicial + «＋»
  await page.click('[data-effect=sequence]');
  await page.waitForSelector('#pSeq', { visible: true });
  assert.equal(await filas(page), 2, 'arranca con 2 colores (p. ej. una bandera de dos colores)');
  assert.equal((await page.$eval('#seqList li:nth-child(1) .nm', n => n.textContent)), 'Color inicial');
  assert.match(await page.$eval('#seqSummary', n => n.textContent), /^2 colores · ciclo de 6 s · se repite hasta DETENER TODO$/);
  assert.equal(await page.$eval('#seqList li:nth-child(1) .del', n => n.disabled), true, 'con 2 colores no se puede quitar ninguno');
  await page.click('#seqAdd'); assert.equal(await filas(page), 3);
  assert.equal((await page.$eval('#seqList li:nth-child(3) .nm', n => n.textContent)), 'Color 3');
  for (let i = 0; i < 9; i++) await page.click('#seqAdd');
  assert.equal(await filas(page), 12); assert.equal(await page.$eval('#seqAdd', n => n.disabled), true, 'máximo 12 colores');
  for (let i = 0; i < 9; i++) await page.click('#seqList li:last-child .del');
  assert.equal(await filas(page), 3);
  // la paleta asigna el color de la fila marcada
  await page.click('#seqList li:nth-child(2)'); await page.click('.color[title="#FF3B30"]');
  assert.equal(await page.$eval(rowSel(2, 'color'), n => n.value), '#ff3b30', 'la paleta colorea la fila 2');
  // valores definitivos: rojo, verde, azul puros, 1 s cada uno
  for (const [i, hex] of [[1, '#ff0000'], [2, '#00ff00'], [3, '#0000ff']]) { await setInput(page, rowSel(i, 'color'), hex); await setInput(page, rowSel(i, 'number'), '1'); }
  assert.match(await page.$eval('#seqSummary', n => n.textContent), /^3 colores · ciclo de 3 s · se repite hasta DETENER TODO$/);
  await page.select('#lead', '800');

  // --- tres teléfonos: normal, con «reducir movimiento» del sistema y con «Efectos: desactivados»
  const A = await openPhone(browser, m.joinUrl); const B = await openPhone(browser, m.joinUrl, { reduced: true }); const C = await openPhone(browser, m.joinUrl, { effectsOff: true });
  await page.click('#send');
  await waitK(page, /^ACEPTADA POR EL SERVIDOR/, 5000);
  const t0 = Date.now(); const sa = [], sb = [], sc = []; let iguales = 0, total = 0;
  while (Date.now() - t0 < 9000) {
    const [a, b, c] = [await color(A), await color(B), await color(C)];
    sa.push(a); sb.push(b); sc.push(c); total++; if (a === b) iguales++; await sleep(50);
  }
  const transiciones = s => { const out = []; let prev = null; for (const x of s) { if (x === '?' || x === prev) continue; if (prev) out.push(prev + '>' + x); prev = x; } return out; };
  const sucesor = { 'K>R': 1, 'R>G': 1, 'G>B': 1, 'B>R': 1 };
  const ta = transiciones(sa);
  assert.ok(ta.length >= 6, 'cambió de color al menos 6 veces en 9 s (3 s por ciclo): ' + ta.join(' '));
  assert.ok(ta.every(x => sucesor[x]), 'siempre en el orden R → G → B → R (ininterrumpida): ' + ta.join(' '));
  assert.ok(ta.filter(x => x === 'B>R').length >= 2, 'vuelve al primer color al terminar cada ciclo (≥ 2 vueltas)');
  assert.ok(transiciones(sb).length >= 6, '«reducir movimiento» no frena una secuencia de pasos ≥ 1 s');
  assert.ok(sc.every(x => x === 'K' || x === 'R'), 'con «Efectos: desactivados» queda fija en el color inicial: ' + [...new Set(sc)]);
  assert.ok(iguales / total >= 0.9, `dos teléfonos cambian a la vez: ${(100 * iguales / total).toFixed(1)} % de muestras iguales`);

  // --- seguridad visual: un paso de 0,5 s se considera intermitente y exige habilitar el strobe
  await setInput(page, rowSel(1, 'number'), '0.5');
  assert.match(await page.$eval('#seqSummary', n => n.textContent), /un paso dura menos de 1 s/);
  await page.waitForSelector('#strobeBox', { visible: true });
  await page.click('#send');
  await waitK(page, /^RECHAZADA: STROBE_DISABLED/, 5000);
  await setInput(page, rowSel(1, 'number'), '1');

  // --- DETENER TODO apaga las pantallas y la secuencia no continúa
  await page.click('#stop');
  await waitK(page, /^ACEPTADA POR EL SERVIDOR/, 5000);
  await sleep(1200);
  for (const p of [A, B, C]) assert.equal(await color(p), 'K', 'pantalla apagada');
  await sleep(3500);
  for (const p of [A, B]) assert.equal(await color(p), 'K', 'y sigue apagada (no se reanuda sola)');
  assert.deepEqual(m.errors, [], 'sin errores de JavaScript en el panel');
});
