'use strict';
// E2E en Chrome REAL (escritorio) de la SINCRONÍA entre teléfonos que escanean el QR en momentos distintos (V3.4.0).
// Mismo equipo => el reloj del servidor es el real: lo medido es el error del ALGORITMO (reloj estimado, dibujo, colas), no el de relojes/pantallas distintos entre
// teléfonos físicos (eso solo se mide con un ensayo físico). Los umbrales son holgados porque la máquina de prueba también carga con varias páginas de Chrome.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, login, createSession, joinMaster, sleep } = require('../test/helpers');
const { run } = require('../tools/sincronia');

const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
const skip = CHROME ? false : 'No hay Chrome/Edge: CHROME_PATH';

test('E2E sincronía: 6 teléfonos con ingresos escalonados (antes y durante la secuencia), relojes locales desfasados y redes asimétricas (20–150 ms, jitter): error de ingreso y de dibujo acotados', { skip, timeout: 150000 }, async t => {
  const r = await run({ phones: 6, seed: 11, skew: 20000, down: [20, 150], up: [20, 150], jitter: 30, secs: 12 });
  const x = r.resumen; t.diagnostic(JSON.stringify({ reloj: x.reloj, dibujo: x.dibujo, total: x.errorAbsMs, dispersion: x.dispersionEntreTelefonosMs }));
  // El reloj de cada teléfono arranca compensado (antes: ≈ la demora de bajada, hasta 176 ms en esta misma red)
  assert.ok(x.reloj.errorInicialAbsMs.max <= 90, 'error inicial del reloj: ' + JSON.stringify(x.reloj.errorInicialAbsMs));
  assert.equal(x.reloj.convergenciaMs.sinConvergir, 0);
  // en régimen el error es la asimetría de cada red (≤ (subida − bajada)/2 ≤ 65 ms + jitter): ninguno supera ~80 ms
  assert.ok(x.reloj.sesgoRegimenAbsMs.max <= 85, 'sesgo de régimen: ' + JSON.stringify(x.reloj.sesgoRegimenAbsMs));
  // los cambios de color se dibujan casi en el instante (antes ~35 ms de p95 por el sondeo a ~30 fps)
  assert.ok(x.dibujo.retrasoMs.p95 <= 30, 'retraso de dibujo: ' + JSON.stringify(x.dibujo));
  assert.ok(x.errorAbsMs.p50 <= 45, 'error total mediano: ' + JSON.stringify(x.errorAbsMs));
  assert.ok(x.cambiosMedidos >= 6 * 8, 'cada teléfono cambió de color varias veces: ' + x.cambiosMedidos);
  assert.ok(x.cambiosFueraDeLugarTotal <= 6, 'sin saltos de corrección espurios (antes: uno por teléfono que se unía tarde): ' + x.cambiosFueraDeLugarTotal);
});

test('E2E sincronía: sin red simulada, los cambios de color se dibujan a ≤ 40 ms de la frontera y la secuencia dibuja SOLO cerca de cada cambio (ahorro de CPU/batería)', { skip, timeout: 90000 }, async t => {
  const srv = await startServer({ wsConnectPerMinPerIp: 1e6, httpPerMin: 1e6 }); t.after(srv.stop);
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const op = await login(srv.base); const s = await createSession(srv.base, op); const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => {
    window.__raf = 0; const nativeRaf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => { window.__raf++; return nativeRaf(cb); };
    window.__log = []; document.addEventListener('DOMContentLoaded', () => { const l = document.getElementById('remote-light'); new MutationObserver(() => window.__log.push([Date.now(), l.style.backgroundColor])).observe(l, { attributes: true, attributeFilter: ['style'] }); });
  });
  await page.goto(s.joinUrl); await page.waitForFunction(() => /CONECTADO/.test(document.getElementById('remote-connection').textContent), { timeout: 8000 });
  master.send({ protocolVersion: 1, type: 'command', commandId: 'sync-seq-0001', leadMs: 1500, payload: { effect: 'sequence', steps: [{ color: '#FF0000', holdMs: 3000 }, { color: '#0000FF', holdMs: 3000 }], fadeMs: 0, durationMs: 0 } });
  const ack = await master.waitFor('ack'); const EX = ack.executeAt;
  await sleep(EX - Date.now() + 100); const raf0 = await page.evaluate(() => window.__raf);
  await sleep(9000);                                                                          // 3 cambios de color (a los 3, 6 y 9 s)
  const frames = (await page.evaluate(() => window.__raf)) - raf0;
  const log = await page.evaluate(() => window.__log);
  const errs = log.filter(([r]) => r >= EX - 50).map(([r]) => { const k = Math.round((r - EX) / 3000); return r - (EX + k * 3000); });
  t.diagnostic(JSON.stringify({ cambios: errs.length, errMs: errs.map(Math.round), cuadros9s: frames }));
  assert.ok(errs.length >= 4, 'se registraron los cambios: ' + errs.length);
  assert.ok(errs.every(e => e >= -5 && e <= 40), 'cada cambio de color se pinta a ≤ 40 ms de su frontera: ' + errs.map(Math.round));
  assert.ok(frames < 60, `en 9 s con cambios cada 3 s solo se dibujan los cuadros cercanos a cada cambio (${frames}; el sondeo continuo a 30 fps serían ≈ 270)`);
});

test('E2E sincronía: un teléfono que escanea el QR A MITAD de la secuencia muestra desde el principio el color que corresponde a ese instante (no arranca desde el primero)', { skip, timeout: 90000 }, async t => {
  const srv = await startServer({ wsConnectPerMinPerIp: 1e6, httpPerMin: 1e6 }); t.after(srv.stop);
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const op = await login(srv.base); const s = await createSession(srv.base, op); const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  master.send({ protocolVersion: 1, type: 'command', commandId: 'sync-mid-0001', leadMs: 300, payload: { effect: 'sequence', steps: [{ color: '#FF0000', holdMs: 4000 }, { color: '#00FF00', holdMs: 4000 }, { color: '#0000FF', holdMs: 4000 }], fadeMs: 0, durationMs: 0 } });
  const ack = await master.waitFor('ack'); const EX = ack.executeAt;
  await sleep(Math.max(0, EX + 7000 - Date.now()));                                           // se une cuando ya van ~7 s (segundo tramo, a punto de pasar al tercero)
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => { window.__log = []; document.addEventListener('DOMContentLoaded', () => { const l = document.getElementById('remote-light'); new MutationObserver(() => window.__log.push([Date.now(), l.style.backgroundColor])).observe(l, { attributes: true, attributeFilter: ['style'] }); }); });
  await page.goto(s.joinUrl); await page.waitForFunction(() => /CONECTADO/.test(document.getElementById('remote-connection').textContent), { timeout: 8000 });
  await sleep(Math.max(0, EX + 10500 - Date.now()));
  const log = (await page.evaluate(() => window.__log)).filter(([, c]) => c && c !== 'rgb(0, 0, 0)');
  assert.ok(log.length >= 1, 'mostró algún color');
  // Cada color pintado debe ser el que corresponde a ese instante REAL de la secuencia (R 0–4 s, G 4–8 s, B 8–12 s desde executeAt); se omiten ±80 ms alrededor de una frontera
  const esperado = r => { const p = (r - EX) % 12000; return p < 4000 ? 'rgb(255, 0, 0)' : p < 8000 ? 'rgb(0, 255, 0)' : 'rgb(0, 0, 255)'; };
  const cercaFrontera = r => [4000, 8000, 12000].some(b => Math.abs(((r - EX) % 12000) - b) < 80);
  for (const [r, c] of log) if (!cercaFrontera(r)) assert.equal(c, esperado(r), 'a los ' + (r - EX) + ' ms desde executeAt debía verse ' + esperado(r));
  assert.ok(!log.some(([, c]) => c === 'rgb(255, 0, 0)'), 'nunca mostró el primer color de la secuencia (no «arranca desde cero»)');
  assert.ok(log.some(([, c]) => c === 'rgb(0, 0, 255)'), 'llegó al tercer color a su hora');
  t.diagnostic(JSON.stringify(log.map(([r, c]) => [r - EX, c])));
});
