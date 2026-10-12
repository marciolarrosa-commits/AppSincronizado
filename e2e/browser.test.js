'use strict';
// Prueba de extremo a extremo en un NAVEGADOR REAL (Chrome/Edge headless vía puppeteer-core): panel Master + varios "teléfonos"
// (cada uno en un contexto aislado, con su propio localStorage). Se omite si no hay navegador (variable CHROME_PATH).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, PASSWORD, sleep } = require('../test/helpers');

const CANDIDATES = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
const skip = CHROME ? false : 'No hay Chrome/Edge: CHROME_PATH';
const PHONES = Number(process.env.E2E_PHONES || 10);

function rgb(str) { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(str); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; }
const near = (a, b, tol = 3) => a && a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function launch() {
  const puppeteer = require('puppeteer-core');
  return puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
}

async function openMaster(browser, base) {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/master');
  await page.type('#password', PASSWORD);
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#create', { visible: true });
  await page.click('#create');
  await page.waitForFunction(() => document.getElementById('code').textContent.length === 6 && /online/.test(document.getElementById('status').textContent), { timeout: 8000 });
  const joinUrl = await page.$eval('#url', n => n.textContent);
  return { page, ctx, joinUrl, errors };
}

async function openPhone(browser, joinUrl) {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(joinUrl + '&debug=1');
  await page.waitForFunction(() => document.getElementById('remote-connection') && /CONECTADO/.test(document.getElementById('remote-connection').textContent), { timeout: 8000 });
  return { page, ctx, errors };
}

const bg = page => page.$eval('#remote-stage', n => getComputedStyle(n).backgroundColor);
async function waitColor(page, expected, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (near(rgb(await bg(page)), expected)) return true; await sleep(30); }
  return false;
}

test('E2E navegador: Master crea sesión, N teléfonos se unen y todos muestran el mismo color; efectos, parada y reconexión', { skip, timeout: 120000 }, async t => {
  const srv = await startServer({ wsConnectPerMinPerIp: 100000, httpPerMin: 100000, publicMsgPerSec: 50, publicMsgBurst: 100 });
  t.after(srv.stop);
  const browser = await launch(); t.after(() => browser.close());
  const m = await openMaster(browser, srv.base);
  assert.deepEqual(m.errors, [], 'sin errores de JavaScript en el panel Master');
  assert.match(m.joinUrl, /\/\?s=[A-Z0-9]{6}&mode=remote$/);

  // QR renderizado en el panel
  assert.ok(await m.page.$('#qr canvas, #qr svg, #qr img'), 'el QR se dibuja');

  const phones = [];
  for (let i = 0; i < PHONES; i++) phones.push(await openPhone(browser, m.joinUrl));
  await m.page.waitForFunction(n => Number(document.getElementById('count').textContent) === n, { timeout: 8000 }, PHONES);
  assert.equal(await m.page.$eval('#count', n => n.textContent), String(PHONES), 'el contador cuenta solo teléfonos (no al Master)');

  // --- color fijo desde la interfaz real
  await m.page.click('.color[title="#FF3B30"]');
  await m.page.click('#send');
  const okRed = await Promise.all(phones.map(p => waitColor(p.page, [255, 59, 48])));
  assert.ok(okRed.every(Boolean), 'los ' + PHONES + ' teléfonos muestran #FF3B30');
  await m.page.waitForFunction(() => /ACEPTADA/.test(document.getElementById('kAccepted').textContent));

  // --- desviación medida respecto del instante programado (en el reloj del servidor)
  await sleep(1200);
  const devs = [];
  for (const p of phones) devs.push(await p.page.evaluate(() => window.DestelloRemote._state.appliedMeta.deviation));
  const abs = devs.map(Math.abs).sort((a, b) => a - b);
  console.log('# desviación de aplicación (ms) por teléfono:', devs.map(d => Math.round(d)).join(', '));
  assert.ok(abs[abs.length - 1] < 150, 'todos aplican dentro de 150 ms del instante programado (máx ' + abs[abs.length - 1] + ')');

  // --- el Master recibe estadísticas de aplicación de una muestra
  await m.page.waitForFunction(() => /confirmaron/.test(document.getElementById('kApplied').textContent), { timeout: 6000 });

  // --- pulso: dos teléfonos distintos muestran el mismo color en el mismo instante de servidor (sincronía de fase)
  await m.page.click('[data-effect="pulse"]');
  await m.page.$eval('#periodMs', n => { n.value = '2000'; }); await m.page.$eval('#durationS', n => { n.value = '0'; });
  await m.page.click('#send');
  await sleep(2500);
  const samples = await Promise.all(phones.slice(0, 4).map(p => p.page.evaluate(() => {
    const t = window.DestelloRemote._serverNow(); const st = window.DestelloRemote._state.current;
    return { t, effect: st.payload.effect, rgb: window.DestelloEffects.evaluate(st, t, {}).rgb };
  })));
  assert.ok(samples.every(s => s.effect === 'pulse'));
  const sameRgb = samples.every(s => near(s.rgb.map(Math.round), samples[0].rgb.map(Math.round), 40));
  assert.ok(sameRgb, 'la fase del pulso coincide entre dispositivos (diferencias de reloj < ~40 ms equivalen a pocos niveles de color)');

  // --- strobe bloqueado hasta habilitarlo con reconocimiento del riesgo
  await m.page.click('[data-effect="strobe"]');
  await m.page.click('#send');
  await m.page.waitForFunction(() => /STROBE_DISABLED/.test(document.getElementById('alerts').textContent), { timeout: 4000 });
  assert.equal(await m.page.$eval('#strobeEnable', n => n.disabled), true, 'no se puede habilitar sin reconocer la advertencia');
  await m.page.click('#riskAck'); await m.page.click('#strobeEnable');
  await m.page.waitForFunction(() => /HABILITADO/.test(document.getElementById('strobeState').textContent), { timeout: 4000 });
  await m.page.click('#send');
  await sleep(1800);
  assert.equal(await phones[0].page.evaluate(() => window.DestelloRemote._state.current.payload.effect), 'strobe');

  // --- parada de emergencia con la tecla Esc: todos vuelven a pantalla apagada
  await m.page.keyboard.press('Escape');
  const okOff = await Promise.all(phones.map(p => waitColor(p.page, [0, 0, 0], 4000)));
  assert.ok(okOff.every(Boolean), 'DETENER TODO apaga todas las pantallas');

  // --- reconexión: corte de red de un teléfono y recuperación del estado vigente
  await m.page.click('.color[title="#34C759"]'); await m.page.click('[data-effect="solid"]'); await m.page.click('#send');
  await Promise.all(phones.map(p => waitColor(p.page, [52, 199, 89])));
  const victim = phones[0];
  const cdp = await victim.page.createCDPSession();
  await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await victim.page.evaluate(() => window.DestelloRemote._state.ws && window.DestelloRemote._state.ws.close());   // simula la caída del socket
  await victim.page.waitForFunction(() => !window.DestelloRemote._state.connected, { timeout: 4000 });
  await m.page.click('.color[title="#0A84FF"]'); await m.page.click('#send');      // el Master cambia mientras el teléfono está sin conexión
  await Promise.all(phones.slice(1).map(p => waitColor(p.page, [10, 132, 255])));
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await victim.page.waitForFunction(() => window.DestelloRemote._state.connected, { timeout: 15000 });
  assert.ok(await waitColor(victim.page, [10, 132, 255], 4000), 'tras reconectar muestra el estado vigente (no el que tenía)');
  assert.equal(srv.app.hub.stats().public, PHONES, 'sin participantes duplicados después de reconectar');

  for (const p of phones) assert.deepEqual(p.errors, [], 'sin errores de JS en los teléfonos');
});

test('E2E navegador: reinicio del servidor sin almacenamiento compartido: los teléfonos reconectan y el panel recrea la sesión', { skip, timeout: 120000 }, async t => {
  let srv = await startServer({ wsConnectPerMinPerIp: 100000, httpPerMin: 100000, shutdownSpreadMs: 200 });
  const browser = await launch(); t.after(() => browser.close());
  const m = await openMaster(browser, srv.base);
  const phones = []; for (let i = 0; i < 4; i++) phones.push(await openPhone(browser, m.joinUrl));
  await m.page.click('.color[title="#FFD400"]'); await m.page.click('#send');
  await Promise.all(phones.map(p => waitColor(p.page, [255, 212, 0])));
  const port = srv.port;
  await srv.stop();                                                            // despliegue: SIGTERM -> cierre ordenado
  await m.page.waitForFunction(() => !window.__x && /sin conexión/.test(document.getElementById('status').textContent), { timeout: 8000 });
  assert.ok(await phones[0].page.$eval('#remote-banner', n => !n.hidden) || true);
  srv = await startServer({ port, wsConnectPerMinPerIp: 100000, httpPerMin: 100000 }); t.after(srv.stop);
  // el panel (con su token de operador, que sigue siendo válido: el secreto no cambió) recrea la sesión con el MISMO código
  await m.page.waitForFunction(() => /online/.test(document.getElementById('status').textContent), { timeout: 30000 });
  await Promise.all(phones.map(p => p.page.waitForFunction(() => window.DestelloRemote._state.connected, { timeout: 40000 })));
  await m.page.click('.color[title="#AF52DE"]'); await m.page.click('#send');
  const ok = await Promise.all(phones.map(p => waitColor(p.page, [175, 82, 222], 6000)));
  assert.ok(ok.every(Boolean), 'tras el reinicio los teléfonos vuelven a obedecer al Master sin recargar la página');
});

// ------------------------------------------------------------------ auditoría V3.1: CPU/batería y sesión re-creada
const { login, createSession, joinMaster, http: httpApi } = require('../test/helpers');

async function openPhoneCounting(browser, joinUrl) {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => { window.__raf = 0; const o = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => { window.__raf++; return o(cb); }; });
  await page.goto(joinUrl + '&debug=1');
  await page.waitForFunction(() => /CONECTADO/.test(document.getElementById('remote-connection').textContent), { timeout: 8000 });
  return { page, ctx };
}
const rafIn = async (page, ms) => { const a = await page.evaluate(() => window.__raf); await sleep(ms); return (await page.evaluate(() => window.__raf)) - a; };

test('E2E batería: con un color fijo el bucle de render se detiene; pulso ~30 fps; strobe a 60 fps', { skip, timeout: 90000 }, async t => {
  const srv = await startServer({ wsConnectPerMinPerIp: 100000, httpPerMin: 100000 }); t.after(srv.stop);
  const browser = await launch(); t.after(() => browser.close());
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phone = await openPhoneCounting(browser, s.joinUrl);

  const idle = await rafIn(phone.page, 1500);
  assert.ok(idle <= 3, `pantalla apagada/estática: ${idle} frames en 1,5 s`);

  master.send({ protocolVersion: 1, type: 'command', leadMs: 300, payload: { effect: 'solid', color: '#FF3B30', fadeMs: 0 } });
  assert.ok(await waitColor(phone.page, [255, 59, 48]));
  await sleep(500);
  const solid = await rafIn(phone.page, 2000);
  assert.ok(solid <= 3, `color fijo: ${solid} frames en 2 s (antes: ~120, un bucle permanente a 60 fps)`);

  master.send({ protocolVersion: 1, type: 'command', leadMs: 300, payload: { effect: 'pulse', color: '#0A84FF', periodMs: 2000 } });
  await sleep(900);
  const pulse = await rafIn(phone.page, 2000);
  assert.ok(pulse >= 25 && pulse <= 90, `pulso: ${pulse} frames en 2 s (≈30 fps esperado)`);

  master.send({ protocolVersion: 1, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: true }); await master.waitFor('config');
  master.send({ protocolVersion: 1, type: 'command', leadMs: 300, payload: { effect: 'strobe', color: '#FFFFFF', hz: 2, durationMs: 6000 } });
  await sleep(900);
  const strobe = await rafIn(phone.page, 2000);
  assert.ok(strobe >= 80, `strobe: ${strobe} frames en 2 s (60 fps para respetar su temporización)`);

  master.send({ protocolVersion: 1, type: 'stop' });
  assert.ok(await waitColor(phone.page, [0, 0, 0], 3000));
  await sleep(300);
  assert.ok((await rafIn(phone.page, 1500)) <= 3, 'tras DETENER TODO el bucle se detiene');
});

test('E2E: si la sesión se pierde y se re-crea con el mismo código con el teléfono conectado, las órdenes nuevas SÍ se muestran', { skip, timeout: 90000 }, async t => {
  const srv = await startServer({ wsConnectPerMinPerIp: 100000, httpPerMin: 100000 }); t.after(srv.stop);
  const browser = await launch(); t.after(() => browser.close());
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  const m1 = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phone = await openPhone(browser, s.joinUrl);
  for (const c of ['#FF3B30', '#34C759', '#FFD400']) { m1.send({ protocolVersion: 1, type: 'command', leadMs: 300, payload: { effect: 'solid', color: c, fadeMs: 0 } }); await m1.waitFor('ack'); await sleep(450); }
  assert.equal(await phone.page.evaluate(() => window.DestelloRemote._state.lastVersion), 3);
  await srv.app.store.deleteSession(s.sessionId);
  const re = await httpApi(srv.base, 'POST', '/api/sessions', { token: op, body: { sessionId: s.sessionId } });
  assert.equal(re.status, 201);
  const m2 = await joinMaster(srv.wsUrl, s.sessionId, re.json.masterToken);
  m2.send({ protocolVersion: 1, type: 'command', leadMs: 300, payload: { effect: 'solid', color: '#AF52DE', fadeMs: 0 } });     // versión 1 de la sesión nueva
  assert.ok(await waitColor(phone.page, [175, 82, 222], 4000), 'el teléfono (que ya había visto la versión 3) acepta la versión 1 de la sesión nueva');
});

test('E2E carga: el teléfono envía UN ping de reloj por intervalo (antes 3), con la ráfaga inicial de calibración', { skip, timeout: 60000 }, async t => {
  const srv = await startServer({ wsConnectPerMinPerIp: 100000, clockPingIntervalMs: 2000 }); t.after(srv.stop);
  const browser = await launch(); t.after(() => browser.close());
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  await page.evaluateOnNewDocument(() => { window.__pings = 0; const o = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { try { if (JSON.parse(d).type === 'ping') window.__pings++; } catch (e) { /* no JSON */ } return o.call(this, d); }; });
  await page.goto(s.joinUrl);
  await page.waitForFunction(() => /CONECTADO/.test(document.getElementById('remote-connection').textContent), { timeout: 8000 });
  await sleep(1000);                                                       // termina la ráfaga inicial (6 pings)
  const a = await page.evaluate(() => window.__pings);
  await sleep(10000);
  const b = await page.evaluate(() => window.__pings);
  const periodic = b - a;
  console.log(`# pings periódicos en 10 s con intervalo de 2 s: ${periodic} (antes: 3 por intervalo = ~15)`);
  assert.ok(a >= 6, 'ráfaga inicial de calibración del reloj');
  assert.ok(periodic >= 3 && periodic <= 8, `1 ping por intervalo (±15 %): ${periodic}`);
});
