'use strict';
// El panel Master REAL (public/js/master.js) en Chrome, con un WebSocket "defectuoso" inyectado que permite retener, descartar, repetir
// e inventar ACKs y perder envíos. Demuestra la política de comandos pendientes (ver public/js/pending.js y docs/PROTOCOLO.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, PASSWORD, joinPublic, sleep, dev } = require('../test/helpers');

const CANDIDATES = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
const skip = CHROME ? false : 'No hay Chrome/Edge: CHROME_PATH';

// Se ejecuta en la página ANTES que master.js: envuelve WebSocket para poder alterar el tráfico de forma determinista.
function faultySocket() {
  const Native = window.WebSocket;
  const net = window.__net = { sentLog: [], ackLog: [], holdAck: new Set(), dropAck: new Set(), dropSend: new Set(), held: [], sockets: [] };
  class FaultyWS {
    constructor(url) {
      this._ws = new Native(url); net.sockets.push(this);
      this._ws.onopen = e => this.onopen && this.onopen(e);
      this._ws.onclose = e => this.onclose && this.onclose(e);
      this._ws.onerror = e => this.onerror && this.onerror(e);
      this._ws.onmessage = e => {
        let m = null; try { m = JSON.parse(e.data); } catch (x) { /* no JSON */ }
        if (m && m.type === 'ack') {
          net.ackLog.push(m.commandId);
          if (net.dropAck.has(m.commandId)) return;
          if (net.holdAck.has(m.commandId)) { net.held.push({ sock: this, e }); return; }
        }
        this.onmessage && this.onmessage(e);
      };
    }
    send(d) {
      let m = null; try { m = JSON.parse(d); } catch (x) { /* no JSON */ }
      if (m && m.commandId) net.sentLog.push(m.type + ':' + m.commandId);
      if (m && m.commandId && net.dropSend.has(m.commandId)) return;          // "se perdió en el camino"
      this._ws.send(d);
    }
    close(c, r) { this._ws.close(c, r); }
    get readyState() { return this._ws.readyState; }
  }
  FaultyWS.CONNECTING = 0; FaultyWS.OPEN = 1; FaultyWS.CLOSING = 2; FaultyWS.CLOSED = 3;
  window.WebSocket = FaultyWS;
  net.release = id => { const i = net.held.findIndex(h => JSON.parse(h.e.data).commandId === id); if (i < 0) return false; const [h] = net.held.splice(i, 1); h.sock.onmessage && h.sock.onmessage(h.e); return true; };
  net.replay = id => { const h = net.held.find(x => JSON.parse(x.e.data).commandId === id); if (h) h.sock.onmessage(h.e); };
  net.inject = obj => { const s = net.sockets[net.sockets.length - 1]; s.onmessage({ data: JSON.stringify(obj) }); };
  net.kill = () => { const s = net.sockets[net.sockets.length - 1]; s._ws.close(); };
}

async function openMaster(browser, base) {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.evaluateOnNewDocument(faultySocket);
  await page.goto(base + '/master');
  await page.type('#password', PASSWORD);
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#create', { visible: true });
  await page.click('#create');
  await page.waitForFunction(() => document.getElementById('code').textContent.length === 6 && /online/.test(document.getElementById('status').textContent), { timeout: 8000 });
  const sid = await page.$eval('#code', n => n.textContent);
  return { page, sid, errors };
}
const idsSent = page => page.evaluate(() => window.__net.sentLog.slice());
const pendingIds = page => page.evaluate(() => window.DestelloMaster.tracker.ids());
async function sendColor(page, hex) { await page.click(`.color[title="${hex}"]`); await page.click('#send'); }
async function lastCommandId(page, n = 1) { const l = (await idsSent(page)).filter(x => x.startsWith('command:')); return l[l.length - n].split(':')[1]; }
async function stateOf(srv, sid) { return (await srv.app.sessions.get(sid)).state; }

async function setup(t, overrides = {}) {
  const puppeteer = require('puppeteer-core');
  const srv = await startServer({ wsConnectPerMinPerIp: 100000, httpPerMin: 100000, masterCommandsPerSec: 50, masterCommandBurst: 50, ...overrides });
  t.after(srv.stop);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const m = await openMaster(browser, srv.base);
  return { srv, browser, m };
}

test('Master/ACK 1+2+3+4: el ACK tardío de A no confirma a B; ACK duplicado y desconocido se ignoran', { skip, timeout: 90000 }, async t => {
  const { srv, m } = await setup(t); const { page, sid } = m;
  const phone = await joinPublic(srv.wsUrl, sid, dev(1));
  // A: su ACK queda retenido. B: su ACK se pierde por completo (ambas órdenes SÍ llegan al servidor).
  const A2 = 'orden-A-aaaaaaaa'; const B2 = 'orden-B-bbbbbbbb';
  await page.evaluate((a, b) => { window.__net.holdAck.add(a); window.__net.dropAck.add(b); }, A2, B2);
  // se envían A2 y B2 con commandId conocido (misma ruta que el botón: tracker + send)
  await page.evaluate((a, b) => {
    const S = window.DestelloMaster;
    const mk = (id, c) => ({ protocolVersion: 1, type: 'command', commandId: id, leadMs: 800, payload: { effect: 'solid', color: c, fadeMs: 0 } });
    window.__sendTracked = (msg) => { S.tracker.add(msg, { kind: 'command', sent: true }); S.state.ws.send(JSON.stringify(msg)); };
    window.__sendTracked(mk(a, '#0A84FF')); window.__sendTracked(mk(b, '#34C759'));
  }, A2, B2);
  await phone.waitFor(m2 => m2.type === 'state' && m2.commandId === B2, 4000, 'B2 aplicada por el servidor');
  assert.deepEqual((await pendingIds(page)).sort(), [A2, B2].sort(), 'ambos pendientes (ACK de A retenido, el de B perdido)');

  // llega TARDE el ACK de A
  assert.equal(await page.evaluate(id => window.__net.release(id), A2), true);
  const afterLate = await pendingIds(page);
  assert.ok(afterLate.includes(B2), 'el ACK tardío de A NO limpió el comando pendiente B');
  assert.ok(!afterLate.includes(A2), 'A sí se confirmó (con su propio ACK)');

  // ACK duplicado de A y ACK de identificador desconocido: no cambian nada
  const before = await page.evaluate(() => ({ pend: window.DestelloMaster.tracker.ids(), acc: document.getElementById('kAccepted').textContent }));
  await page.evaluate(() => window.__net.inject({ protocolVersion: 1, type: 'ack', commandId: 'orden-A-aaaaaaaa', stateVersion: 7, executeAt: Date.now() + 500, serverTimestamp: Date.now() }));
  await page.evaluate(() => window.__net.inject({ protocolVersion: 1, type: 'ack', commandId: 'desconocido-0001', stateVersion: 9, executeAt: Date.now() + 500, serverTimestamp: Date.now() }));
  const after = await page.evaluate(() => ({ pend: window.DestelloMaster.tracker.ids(), acc: document.getElementById('kAccepted').textContent, st: window.DestelloMaster.tracker.stats }));
  assert.deepEqual(after.pend, before.pend, 'duplicado/desconocido no alteran los pendientes');
  assert.equal(after.acc, before.acc, 'ni el texto de estado de la orden actual');
  assert.ok(after.st.ackedDuplicate >= 1 && after.st.ackedUnknown >= 1);

  // 5) timeout y reintento: B sigue sin ACK -> el panel reenvía el MISMO commandId; el servidor responde "duplicada" y se limpia
  await page.evaluate(b => window.__net.dropAck.delete(b), B2);
  await page.waitForFunction(b => !window.DestelloMaster.tracker.has(b), { timeout: 9000 }, B2);
  const sent = await idsSent(page);
  assert.ok(sent.filter(x => x === 'command:' + B2).length >= 2, 'B2 se reenvió con el mismo commandId: ' + sent.filter(x => x.includes(B2)).length + ' envíos');
  const st = await stateOf(srv, sid);
  assert.equal(st.commandId, B2, 'el estado final sigue siendo B2 (no hubo reversión)');
  await sleep(300);
  assert.equal(phone.msgs.filter(x => x.type === 'state' && x.commandId === B2).length, 0, 'el teléfono no recibió B2 por segunda vez');
  assert.deepEqual(m.errors, []);
});

test('Master/ACK 6+7: la orden se pierde en el camino y la conexión cae: tras reconectar se reenvía y el estado se recupera', { skip, timeout: 90000 }, async t => {
  const { srv, m } = await setup(t); const { page, sid } = m;
  const phone = await joinPublic(srv.wsUrl, sid, dev(1));
  await page.evaluate(() => { window.DestelloMaster.state.connected; });
  // A llega y se confirma; B se pierde en el camino (nunca llega al servidor) y su ACK jamás existirá
  await sendColor(page, '#FF3B30'); await phone.waitFor(x => x.type === 'state' && x.stateVersion === 1, 4000, 'A aplicada');
  await page.waitForFunction(() => window.DestelloMaster.tracker.size() === 0);
  await page.click('.color[title="#34C759"]');
  // se marca B para perderse en el camino ANTES de enviarla (se conoce su id al crearla: la interceptamos por contenido)
  await page.evaluate(() => {
    const net = window.__net; const orig = net.sockets[net.sockets.length - 1].send.bind(net.sockets[net.sockets.length - 1]);
    net.sockets[net.sockets.length - 1].send = d => { const m = JSON.parse(d); if (m.type === 'command') { net.sentLog.push('command:' + m.commandId); net.lostId = m.commandId; return; } orig(d); };
  });
  await page.click('#send');
  const B = await page.evaluate(() => window.__net.lostId);
  assert.ok(B, 'B fue "enviada" y perdida');
  assert.equal((await stateOf(srv, sid)).stateVersion, 1, 'el servidor nunca vio B');
  assert.deepEqual(await pendingIds(page), [B]);

  // cae la conexión con B pendiente
  await page.evaluate(() => window.__net.kill());
  await page.waitForFunction(() => !window.DestelloMaster.state.connected, { timeout: 4000 });
  await page.waitForFunction(() => window.DestelloMaster.state.connected, { timeout: 15000 });
  // al reconectar se reenvía B con el MISMO commandId, el servidor la aplica UNA vez y llega al teléfono
  const got = await phone.waitFor(x => x.type === 'state' && x.commandId === B, 6000, 'B reenviada tras reconectar');
  assert.equal(got.stateVersion, 2); assert.equal(got.payload.color, '#34C759');
  await page.waitForFunction(() => window.DestelloMaster.tracker.size() === 0, { timeout: 5000 });
  assert.equal((await stateOf(srv, sid)).commandId, B);
  // 7) el panel recuperó el estado vigente
  assert.match(await page.$eval('#kState', n => n.textContent), /v2/);
  assert.deepEqual(m.errors, []);
});

test('Master/ACK: una orden antigua pendiente NO se reaplica tras reconectar si fue reemplazada por otra más nueva', { skip, timeout: 90000 }, async t => {
  const { srv, m } = await setup(t); const { page, sid } = m;
  const phone = await joinPublic(srv.wsUrl, sid, dev(1));
  await page.evaluate(() => {
    const net = window.__net; const sock = net.sockets[net.sockets.length - 1];
    sock.send = d => { const m = JSON.parse(d); if (m.type === 'command') net.sentLog.push('command:' + m.commandId); };     // el enlace "perdió" todo lo que se envía
  });
  await sendColor(page, '#FF3B30'); await sendColor(page, '#0A84FF');                                                     // A y B, ninguna llegó
  const [A, B] = [await lastCommandId(page, 2), await lastCommandId(page, 1)];
  await page.evaluate(() => window.__net.kill());
  await page.waitForFunction(() => window.DestelloMaster.state.connected, { timeout: 15000 });
  const got = await phone.waitFor(x => x.type === 'state', 6000, 'solo B');
  assert.equal(got.commandId, B, 'se reenvió únicamente la orden más reciente');
  await sleep(500);
  assert.equal(phone.msgs.filter(x => x.type === 'state').length, 0, 'A (reemplazada) nunca se aplicó');
  assert.equal((await stateOf(srv, sid)).stateVersion, 1);
  assert.notEqual(A, B);
});
