'use strict';
// E2E en Chrome/Edge REAL (escritorio) de la pantalla del participante: mantenimiento de la pantalla encendida (Wake Lock) y diagnóstico del color.
// Un Wake Lock SIMULADO (inyectado antes de la página) permite reproducir rechazos y liberaciones del sistema; NO prueba un Samsung real:
// demuestra la lógica de reintento y que el diagnóstico informa el estado y el color que la página calcula y pinta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, login, createSession, joinMaster, sleep } = require('../test/helpers');

const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
const skip = CHROME ? false : 'No hay Chrome/Edge: CHROME_PATH';

// Se ejecuta ANTES que remote.js. `denyFirst`: cuántas solicitudes rechaza (un número enorme = siempre; Infinity no sobrevive a la serialización); `none`: navegador sin Wake Lock.
function fakeWakeLock({ denyFirst, none }) {
  window.__wl = { calls: 0, locks: [] };
  if (none) { Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined }); return; }
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async () => {
        window.__wl.calls++;
        if (window.__wl.calls <= denyFirst) throw new DOMException('denegado (simulado)', 'NotAllowedError');
        const l = new EventTarget(); l.release = async () => {}; window.__wl.locks.push(l); return l;
      }
    }
  });
}

async function setup(t, wake) {
  const srv = await startServer({ wsConnectPerMinPerIp: 1e6, httpPerMin: 1e6 }); t.after(srv.stop);
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  if (wake) await page.evaluateOnNewDocument(fakeWakeLock, wake);
  await page.goto(s.joinUrl);
  await page.waitForFunction(() => document.getElementById('remote-connection') && /CONECTADO/.test(document.getElementById('remote-connection').textContent), { timeout: 8000 });
  return { srv, s, page, errors };
}
const openDiag = async page => { await page.evaluate(() => window.DestelloRemote.openPanel()); };
const diag = page => page.$eval('#remote-diag', n => n.textContent);
const waitDiag = (page, re, timeout = 12000) => page.waitForFunction(r => new RegExp(r).test(document.getElementById('remote-diag').textContent), { timeout }, re.source);

test('Pantalla encendida: un rechazo del Wake Lock se REINTENTA con espera creciente hasta lograrlo; si el sistema lo libera, se vuelve a pedir', { skip, timeout: 60000 }, async t => {
  const { page, errors } = await setup(t, { denyFirst: 2 });
  await openDiag(page);
  await waitDiag(page, /Wake Lock\): DENEGADA \(NotAllowedError\)/, 5000);                       // el rechazo se VE (antes se ignoraba en silencio)
  await page.waitForFunction(() => window.__wl.locks.length === 1, { timeout: 12000 });         // 1.º y 2.º rechazados, 3.º concedido (~3 s)
  assert.equal(await page.evaluate(() => window.__wl.calls), 3);
  await waitDiag(page, /Wake Lock\): activa/, 3000);
  // el sistema libera el bloqueo (p. ej. ahorro de batería): se vuelve a solicitar solo
  await page.evaluate(() => window.__wl.locks[0].dispatchEvent(new Event('release')));
  await page.waitForFunction(() => window.__wl.locks.length === 2, { timeout: 5000 });
  await waitDiag(page, /Wake Lock\): activa/, 3000);
  assert.equal(await page.evaluate(() => window.DestelloRemote._state.wake.grants), 2);
  assert.deepEqual(errors, []);
});

test('Pantalla encendida: si el navegador lo rechaza SIEMPRE o no lo soporta, el diagnóstico lo dice con claridad (la pantalla podría atenuarse)', { skip, timeout: 60000 }, async t => {
  const a = await setup(t, { denyFirst: 1e9 });
  await openDiag(a.page);
  await waitDiag(a.page, /DENEGADA \(NotAllowedError\): la pantalla puede atenuarse · reintento [1-9]/, 8000);
  const calls = await a.page.evaluate(() => window.__wl.calls); await sleep(2500);
  assert.ok(await a.page.evaluate(() => window.__wl.calls) > calls, 'sigue reintentando');
  const b = await setup(t, { none: true });
  await openDiag(b.page);
  await waitDiag(b.page, /Wake Lock\): NO disponible en este navegador/, 5000);
});

test('Diagnóstico de color: el panel informa el color que la página CALCULA y el que PINTA (blanco y amarillo exactos), más el entorno de pantalla', { skip, timeout: 60000 }, async t => {
  const { srv, s, page } = await setup(t, { denyFirst: 0 });
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const send = (id, color) => master.send({ protocolVersion: 1, type: 'command', commandId: id, leadMs: 300, payload: { effect: 'solid', color, fadeMs: 0 } });
  for (const [id, hex, rgb] of [['e2e-color-0001', '#FFFFFF', 'rgb(255, 255, 255)'], ['e2e-color-0002', '#FFD400', 'rgb(255, 212, 0)']]) {
    send(id, hex); await master.waitFor(m => m.type === 'ack' && m.commandId === id);
    await page.waitForFunction(c => getComputedStyle(document.getElementById('remote-light')).backgroundColor === c, { timeout: 5000 }, rgb);
    await openDiag(page);
    await waitDiag(page, new RegExp('Color: calculado ' + rgb.replace(/[()]/g, m => '\\' + m) + ' · pintado ' + rgb.replace(/[()]/g, m => '\\' + m)), 4000);
    const d = await diag(page);
    assert.match(d, /tema (claro|oscuro)/); assert.match(d, /gama (srgb|p3|rec2020)/); assert.match(d, /\d+ bits/);
  }
});
