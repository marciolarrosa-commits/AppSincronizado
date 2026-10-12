'use strict';
// Cliente del público en Chrome real bajo condiciones de red adversas (latencia simétrica/asimétrica, llegada tardía, cortes repetidos,
// mensajes malformados, pestaña oculta). Un WebSocket envoltorio retrasa/inyecta tráfico; el reloj del servidor y el del navegador son el
// mismo (mismo equipo), así que la desviación real = hora local al aplicar − executeAt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, login, createSession, joinMaster, sleep } = require('../test/helpers');

const CANDIDATES = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
const skip = CHROME ? false : 'No hay Chrome/Edge: CHROME_PATH';

function netWrapper() {
  const Native = window.WebSocket;
  const net = window.__net = { down: 0, up: 0, sockets: [] };
  class W {
    constructor(u) {
      this._ws = new Native(u); net.sockets.push(this);
      this._ws.onopen = e => this.onopen && this.onopen(e);
      this._ws.onclose = e => this.onclose && this.onclose(e);
      this._ws.onerror = e => this.onerror && this.onerror(e);
      this._ws.onmessage = e => { const f = () => this.onmessage && this.onmessage(e); net.down > 0 ? setTimeout(f, net.down) : f(); };
    }
    send(d) { const f = () => { try { this._ws.send(d); } catch (x) { /* cerrado */ } }; net.up > 0 ? setTimeout(f, net.up) : f(); }
    close(c, r) { this._ws.close(c, r); }
    get readyState() { return this._ws.readyState; }
  }
  W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3;
  window.WebSocket = W;
  net.inject = o => net.sockets[net.sockets.length - 1].onmessage({ data: JSON.stringify(o) });
  net.kill = () => net.sockets[net.sockets.length - 1]._ws.close();
}

async function setup(t, srvOverrides = {}) {
  const puppeteer = require('puppeteer-core');
  const srv = await startServer({ wsConnectPerMinPerIp: 100000, httpPerMin: 100000, ...srvOverrides }); t.after(srv.stop);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  async function phone(down, up) {
    const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(netWrapper);
    await page.evaluateOnNewDocument((d, u) => { window.__netInit = { d, u }; }, down, up);
    await page.evaluateOnNewDocument(() => { const i = window.__netInit; window.__net.down = i.d; window.__net.up = i.u; });
    await page.goto(s.joinUrl + '&debug=1');
    await page.waitForFunction(() => window.DestelloRemote && window.DestelloRemote._state.connected, { timeout: 15000 });
    return page;
  }
  return { srv, s, master, phone };
}
const color = (c, lead = 1500) => ({ protocolVersion: 1, type: 'command', leadMs: lead, payload: { effect: 'solid', color: c, fadeMs: 0 } });
const rgbOf = page => page.evaluate(() => window.DestelloRemote._state.shown.map(Math.round));
async function trueDeviation(page, executeAt) { return page.evaluate(() => { const m = window.DestelloRemote._state.appliedMeta; return m.wallAt; }).then(w => w - executeAt); }

test('red lenta SIMÉTRICA (150 ms por sentido): la aplicación sigue ajustada a executeAt gracias al reloj sincronizado', { skip, timeout: 90000 }, async t => {
  const { master, phone } = await setup(t);
  const p = await phone(150, 150);
  await sleep(2500);                                                         // la calibración del reloj con latencia tarda un poco
  master.send(color('#FF3B30')); const ack = await master.waitFor('ack');
  await p.waitForFunction(() => window.DestelloRemote._state.appliedMeta.version === 1, { timeout: 6000 });
  const dev = await trueDeviation(p, ack.executeAt);
  console.log(`# desviación real con 150 ms simétricos: ${Math.round(dev)} ms`);
  assert.ok(Math.abs(dev) <= 60, `desviación ${dev} ms`);
  assert.deepEqual(await rgbOf(p), [255, 59, 48]);
});

test('red ASIMÉTRICA (bajada 400 ms, subida 20 ms): el error del reloj es ≈ la mitad de la asimetría (limitación conocida de la estimación tipo NTP)', { skip, timeout: 90000 }, async t => {
  const { master, phone } = await setup(t);
  const p = await phone(400, 20);
  await sleep(3000);
  master.send(color('#0A84FF')); const ack = await master.waitFor('ack');
  await p.waitForFunction(() => window.DestelloRemote._state.appliedMeta.version === 1, { timeout: 8000 });
  const dev = await trueDeviation(p, ack.executeAt);
  console.log(`# desviación real con red asimétrica 400/20 ms: ${Math.round(dev)} ms (asimetría/2 = 190 ms)`);
  assert.ok(Math.abs(dev) >= 100 && Math.abs(dev) <= 300, `se esperaba ≈190 ms de error por asimetría, medido ${dev}`);
});

test('llegada TARDÍA (bajada 2,5 s > margen 1,5 s): se aplica de inmediato (nunca queda oculta) y se informa como llegada tardía', { skip, timeout: 90000 }, async t => {
  const { master, phone, srv } = await setup(t);
  const p = await phone(2500, 0);
  await sleep(3000);
  master.send(color('#34C759', 800));
  const stats = await master.waitFor(m => m.type === 'stats' && m.lateArrival >= 1, 14000, 'stats con llegada tardía');
  assert.ok(stats.lateArrival >= 1);
  assert.deepEqual(await rgbOf(p), [52, 199, 89], 'el color se mostró (tarde, pero se mostró)');
  assert.ok(await p.evaluate(() => window.DestelloRemote._state.stats.lateArrivals) >= 1);
});

test('conexión intermitente: tres cortes seguidos del socket -> reconecta sin duplicar y converge al estado vigente', { skip, timeout: 90000 }, async t => {
  const { master, phone, srv } = await setup(t);
  const p = await phone(0, 0);
  for (let i = 0; i < 3; i++) {
    await p.evaluate(() => window.__net.kill());
    await p.waitForFunction(() => !window.DestelloRemote._state.connected, { timeout: 4000 });
    master.send(color(['#FF3B30', '#34C759', '#AF52DE'][i], 300));                // el Master cambia mientras el teléfono está sin conexión
    await p.waitForFunction(() => window.DestelloRemote._state.connected, { timeout: 20000 });
  }
  await sleep(600);
  assert.deepEqual(await rgbOf(p), [175, 82, 222], 'converge al ÚLTIMO estado');
  assert.equal(srv.app.hub.stats().public, 1, 'un solo participante registrado');
  assert.ok(srv.app.metrics.get('reconnects') >= 3);
});

test('mensajes malformados del servidor se ignoran sin romper el render; el siguiente mensaje válido funciona', { skip, timeout: 60000 }, async t => {
  const { master, phone } = await setup(t);
  const p = await phone(0, 0);
  master.send(color('#FFD400', 300)); await p.waitForFunction(() => window.DestelloRemote._state.lastVersion === 1, { timeout: 4000 });
  await sleep(500);
  const before = await rgbOf(p);
  for (const bad of [
    { protocolVersion: 1, type: 'state', stateVersion: 50, executeAt: 0, payload: { effect: 'solid', color: 'rojo' } },
    { protocolVersion: 1, type: 'state', stateVersion: 51, executeAt: 0, payload: null },
    { protocolVersion: 1, type: 'state', stateVersion: 52, executeAt: 0, payload: { effect: 'boom', color: '#FFFFFF' } },
    { protocolVersion: 1, type: 'state', stateVersion: 53, executeAt: 0, payload: { effect: 'solid', color: '#FFFFFF', fadeMs: 'x' } }]) {
    await p.evaluate(m => window.__net.inject(m), bad);
  }
  await sleep(300);
  assert.deepEqual(await rgbOf(p), before, 'el color mostrado no cambió');
  assert.equal(await p.evaluate(() => window.DestelloRemote._state.lastVersion), 1, 'la línea base de versiones no se contaminó con estados inválidos');
  assert.ok(await p.evaluate(() => window.DestelloRemote._state.stats.invalid) >= 4);
  master.send(color('#00C7BE', 300));
  await p.waitForFunction(() => window.DestelloRemote._state.lastVersion === 2, { timeout: 4000 });
  await sleep(600); assert.deepEqual(await rgbOf(p), [0, 199, 190]);
});

test('pestaña oculta/visible: al volver, el teléfono reconecta enseguida y aplica el estado vigente', { skip, timeout: 90000 }, async t => {
  const { master, phone, srv } = await setup(t);
  const p = await phone(0, 0);
  await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await p.evaluate(() => window.__net.kill());                                  // el navegador cerró el socket en segundo plano
  await p.waitForFunction(() => !window.DestelloRemote._state.connected, { timeout: 4000 });
  master.send(color('#AF52DE', 300));                                           // mientras estaba en segundo plano
  await sleep(500);
  await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await p.waitForFunction(() => window.DestelloRemote._state.connected, { timeout: 5000 });     // reconexión inmediata (≤ 0,8 s de jitter), no espera el backoff
  await sleep(700);
  assert.deepEqual(await rgbOf(p), [175, 82, 222]);
  assert.equal(srv.app.hub.stats().public, 1);
});
