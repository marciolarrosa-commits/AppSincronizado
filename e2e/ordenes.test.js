'use strict';
// E2E en Chrome/Edge REAL (escritorio): el panel /master REAL (master.js + orders.js) manejando un teléfono REAL (remote.js + effects.js) contra el servidor real.
// Demuestra el ciclo de vida de las órdenes (aceptada / rechazada / aplicada / sin confirmación) y que los cuatro efectos llegan y se ven en el cliente.
// No es un iPhone ni un Android físico. Se omite si no hay navegador (CHROME_PATH).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, PASSWORD, joinPublic, sleep, dev } = require('../test/helpers');

const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
const skip = CHROME ? false : 'No hay Chrome/Edge: CHROME_PATH';

const rgb = s => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s); return m ? [+m[1], +m[2], +m[3]] : null; };
const near = (a, b, tol = 6) => a && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const YELLOW = [255, 212, 0]; const BLUE = [10, 132, 255];            // #FFD400 y #0A84FF: color y segundo color predeterminados del panel

async function openMaster(browser, base) {
  const page = await (await browser.createBrowserContext()).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/master'); await page.type('#password', PASSWORD); await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#create', { visible: true }); await page.click('#create');
  await page.waitForFunction(() => document.getElementById('code').textContent.length === 6 && /online/.test(document.getElementById('status').textContent), { timeout: 8000 });
  return { page, errors, joinUrl: await page.$eval('#url', n => n.textContent), sid: await page.$eval('#code', n => n.textContent) };
}
async function openPhone(browser, joinUrl) {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(joinUrl);
  await page.waitForFunction(() => document.getElementById('remote-connection') && /CONECTADO/.test(document.getElementById('remote-connection').textContent), { timeout: 8000 });
  return { page, errors };
}
const bg = page => page.$eval('#remote-stage', n => getComputedStyle(n).backgroundColor).then(rgb);
const text = (page, id) => page.$eval('#' + id, n => n.textContent);
async function apply(page, effect) { await page.click(`[data-effect=${effect}]`); await page.click('#send'); }
const waitText = (page, id, re, timeout = 9000) => page.waitForFunction((i, r) => new RegExp(r).test(document.getElementById(i).textContent), { timeout }, id, re.source);
async function sample(phone, ms, every = 40) { const out = []; const end = Date.now() + ms; while (Date.now() < end) { out.push(await bg(phone)); await sleep(every); } return out; }

async function setup(t, overrides = {}) {
  const srv = await startServer({ wsConnectPerMinPerIp: 1e6, httpPerMin: 1e6, ...overrides }); t.after(srv.stop);
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] }); t.after(() => browser.close());
  return { srv, browser };
}

test('E2E órdenes: Fijo, Transición, Pulso y Strobe desde el panel real; cada uno se acepta, se ve en el teléfono y se confirma como APLICADA; Strobe sin habilitar se RECHAZA y el indicador se recupera', { skip, timeout: 120000 }, async t => {
  const { srv, browser } = await setup(t);
  const m = await openMaster(browser, srv.base);
  const ph = await openPhone(browser, m.joinUrl); const phone = ph.page;
  assert.equal(await text(m.page, 'kAccepted'), '—', 'sin órdenes: indicador en reposo');

  // --- FIJO
  await apply(m.page, 'solid');
  await waitText(m.page, 'kAccepted', /^ACEPTADA POR EL SERVIDOR · v1 · ejecuta en \d+ ms/);
  await m.page.waitForFunction(() => /^APLICADA: 1 dispositivos confirmaron/.test(document.getElementById('kApplied').textContent), { timeout: 9000 });
  assert.ok(near(await bg(phone), YELLOW), 'el teléfono muestra el color fijo: ' + await bg(phone));

  // --- TRANSICIÓN: color -> color2 (500 ms) y se queda en color2
  await apply(m.page, 'fade');
  await waitText(m.page, 'kAccepted', /^ACEPTADA POR EL SERVIDOR · v2/);
  await m.page.waitForFunction(() => /^APLICADA: 1 dispositivos confirmaron/.test(document.getElementById('kApplied').textContent), { timeout: 9000 });
  await sleep(300); assert.ok(near(await bg(phone), BLUE), 'terminó en el segundo color: ' + await bg(phone));

  // --- PULSO: oscila entre color2 y color con período de 2 s
  await apply(m.page, 'pulse');
  await waitText(m.page, 'kAccepted', /^ACEPTADA POR EL SERVIDOR · v3/);
  await m.page.waitForFunction(() => /^APLICADA: 1 dispositivos confirmaron/.test(document.getElementById('kApplied').textContent), { timeout: 9000 });
  const pulse = await sample(phone, 2300, 60);
  assert.ok(pulse.some(c => near(c, YELLOW, 40)) && pulse.some(c => near(c, BLUE, 40)), 'el pulso recorre ambos extremos');
  assert.ok(new Set(pulse.map(c => c.join())).size > 10, 'y pasa por colores intermedios (animación)');

  // --- STROBE sin habilitar: RECHAZADA (no queda en «ENVIANDO…») con código y explicación
  await apply(m.page, 'strobe');
  await waitText(m.page, 'kAccepted', /^RECHAZADA: STROBE_DISABLED — /, 5000);
  assert.ok(!/ENVIANDO/.test(await text(m.page, 'kAccepted')));
  assert.match(await text(m.page, 'kApplied'), /no aplica/);
  assert.match(await m.page.$eval('#alerts', n => n.textContent), /STROBE_DISABLED: el strobe está deshabilitado/);
  assert.equal(await m.page.$eval('#kAccepted', n => n.className), 'st-bad');
  assert.match(await text(m.page, 'orderLog'), /Strobe[\s\S]*rechazada/i);

  // --- se habilita con la advertencia y funciona: el teléfono alterna color / color2 a ~2 Hz
  await m.page.click('#riskAck'); await m.page.click('#strobeEnable');
  await m.page.waitForFunction(() => /HABILITADO/.test(document.getElementById('strobeState').textContent), { timeout: 5000 });
  await apply(m.page, 'strobe');
  await waitText(m.page, 'kAccepted', /^ACEPTADA POR EL SERVIDOR · v4/, 5000);
  await m.page.waitForFunction(() => /^APLICADA: 1 dispositivos confirmaron/.test(document.getElementById('kApplied').textContent), { timeout: 9000 });
  const strobe = await sample(phone, 1600, 30);
  assert.ok(strobe.some(c => near(c, YELLOW, 20)) && strobe.some(c => near(c, BLUE, 20)), 'strobe: se ven color y color2 alternando');

  // --- el indicador SE RECUPERA con una orden nueva (STOP) y no arrastra el estado anterior
  await m.page.click('#stop');
  await waitText(m.page, 'kAccepted', /^ACEPTADA POR EL SERVIDOR · v5/, 5000);
  await sleep(900); assert.ok(near(await bg(phone), [0, 0, 0], 4), 'DETENER TODO apaga la pantalla');
  assert.deepEqual(m.errors, [], 'sin errores de JavaScript en el panel'); assert.deepEqual(ph.errors, [], 'ni en el teléfono');
});

test('E2E órdenes: el panel no deja pasar valores que el servidor rechazaría (duración de strobe) y avisa del ajuste', { skip, timeout: 60000 }, async t => {
  const { srv, browser } = await setup(t);
  const m = await openMaster(browser, srv.base);
  await m.page.click('[data-effect=strobe]');
  await m.page.click('#riskAck'); await m.page.click('#strobeEnable');
  await m.page.waitForFunction(() => /HABILITADO/.test(document.getElementById('strobeState').textContent), { timeout: 5000 });
  assert.equal(await m.page.$eval('#durationS', n => n.max), '30', 'el límite visible coincide con el del servidor (30 s)');
  await m.page.$eval('#durationS', n => { n.value = '120'; });                       // el operador teclea 120 s
  await m.page.click('#send');
  await waitText(m.page, 'kAccepted', /^ACEPTADA POR EL SERVIDOR/, 5000);               // antes: OUT_OF_RANGE y «ENVIANDO…» para siempre
  assert.match(await m.page.$eval('#alerts', n => n.textContent), /Duración ajustado a 30 s/);
  assert.equal((await srv.app.sessions.get(m.sid)).state.payload.durationMs, 30000);
});

test('E2E órdenes: sin dispositivos conectados la orden queda «ACEPTADA» y el estado de DISPOSITIVOS termina en «SIN DISPOSITIVOS CONECTADOS» (plazo finito)', { skip, timeout: 60000 }, async t => {
  const { srv, browser } = await setup(t);
  const m = await openMaster(browser, srv.base);
  await m.page.select('#lead', '800');
  await apply(m.page, 'solid');
  await waitText(m.page, 'kAccepted', /^ACEPTADA POR EL SERVIDOR/, 5000);
  assert.match(await text(m.page, 'kApplied'), /esperando confirmaciones/);
  await waitText(m.page, 'kApplied', /^SIN DISPOSITIVOS CONECTADOS/, 15000);
  assert.ok(!/APLICADA/.test(await text(m.page, 'kApplied')));
});

test('E2E órdenes: hay dispositivos conectados pero NINGUNO confirma -> «SIN CONFIRMACIÓN DE DISPOSITIVOS» (aceptar no es aplicar)', { skip, timeout: 60000 }, async t => {
  const { srv, browser } = await setup(t);
  const m = await openMaster(browser, srv.base);
  const mute = await joinPublic(srv.wsUrl, m.sid, dev(1));                           // teléfono conectado que no informa nada
  await m.page.select('#lead', '800');
  await apply(m.page, 'fade');
  await waitText(m.page, 'kAccepted', /^ACEPTADA POR EL SERVIDOR/, 5000);
  await mute.waitFor('state');
  await waitText(m.page, 'kApplied', /^SIN CONFIRMACIÓN DE DISPOSITIVOS/, 15000);
  assert.match(await text(m.page, 'kApplied'), /NO demostrada/);
  assert.match(await text(m.page, 'kAccepted'), /^ACEPTADA POR EL SERVIDOR/, 'el estado del servidor no se degrada');
});

test('E2E cliente: al cargar, el teléfono abre UN solo WebSocket y no se reconecta sin motivo (regresión: pageshow cerraba el socket sano y la orden llegaba como estado inicial, sin informar su aplicación)', { skip, timeout: 60000 }, async t => {
  const { srv, browser } = await setup(t);
  const m = await openMaster(browser, srv.base);
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  const cdp = await page.createCDPSession(); await cdp.send('Network.enable');
  let hellos = 0; let opened = 0;
  cdp.on('Network.webSocketFrameSent', e => { if (/"type":"hello"/.test(e.response.payloadData)) hellos++; });
  cdp.on('Network.webSocketCreated', () => { opened++; });
  await page.goto(m.joinUrl);
  await page.waitForFunction(() => document.getElementById('remote-connection') && /CONECTADO/.test(document.getElementById('remote-connection').textContent), { timeout: 8000 });
  await apply(m.page, 'solid');                                   // la orden llega JUSTO tras conectar
  await m.page.waitForFunction(() => /^APLICADA: 1 dispositivos confirmaron/.test(document.getElementById('kApplied').textContent), { timeout: 9000 });
  assert.equal(opened, 1, 'un solo WebSocket'); assert.equal(hellos, 1, 'un solo hello (sin reconexiones espurias)');
});

test('E2E órdenes (regresión): pasar de Pulso con duración 0 («sin límite») a Strobe NO deja el strobe en 0,5 s: usa 10 s y no avisa de ajustes', { skip, timeout: 60000 }, async t => {
  const { srv, browser } = await setup(t);
  const m = await openMaster(browser, srv.base);
  await m.page.click('[data-effect=pulse]');
  await m.page.$eval('#durationS', n => { n.value = '0'; });                          // como en la captura del usuario
  await m.page.click('[data-effect=strobe]');
  assert.equal(await m.page.$eval('#durationS', n => n.value), '10', 'al elegir Strobe, el 0 heredado de Pulso pasa a 10 s');
  await m.page.click('#riskAck'); await m.page.click('#strobeEnable');
  await m.page.waitForFunction(() => /HABILITADO/.test(document.getElementById('strobeState').textContent), { timeout: 5000 });
  await m.page.$eval('#durationS', n => { n.value = '0'; });                          // y aunque se teclee 0 a mano
  await m.page.click('#send');
  await waitText(m.page, 'kAccepted', /^ACEPTADA POR EL SERVIDOR/, 5000);
  assert.equal((await srv.app.sessions.get(m.sid)).state.payload.durationMs, 10000);
  assert.ok(!/ajustado/.test(await m.page.$eval('#alerts', n => n.textContent)), 'sin avisos de ajuste espurios');
});
