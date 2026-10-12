'use strict';
// Utilidades de prueba: arranca el servidor real en un puerto libre y ofrece un cliente WebSocket con esperas por promesa.
const WebSocket = require('ws');
const { createApp } = require('../src/app');

const PASSWORD = 'password-de-prueba-123';

// Puertos que fetch (undici) se niega a usar por estándar («bad port»): si el SO asigna uno de ellos al puerto 0, la prueba fallaría al preparar el servidor
// (pasó de forma intermitente con ordenes-servidor). Se reintenta con otro puerto; no tiene relación con lo que se prueba.
const FETCH_BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

async function startServer(overrides = {}, deps = {}) {
  for (let attempt = 0; ; attempt++) {
    const logs = [];
    const app = createApp({
      port: 0, host: '127.0.0.1', masterPassword: PASSWORD, masterPasswordGenerated: false,
      tokenSecret: 'secreto-de-prueba-0123456789abcdef', allowNoOrigin: true, logLevel: 'error',
      heartbeatMs: 3000, helloTimeoutMs: 1500, shutdownGraceMs: 4000, shutdownSpreadMs: 300,
      presenceIntervalMs: 200, presenceTtlMs: 3000, defaultLeadMs: 400, minLeadMs: 100,
      ...overrides
    }, { logSink: l => logs.push(l), ...deps });
    const addr = await app.start();
    if (FETCH_BAD_PORTS.has(addr.port) && !overrides.port && attempt < 20) { await app.shutdown('puerto-no-apto'); continue; }
    const base = `http://127.0.0.1:${addr.port}`;
    return { app, base, wsUrl: `ws://127.0.0.1:${addr.port}/ws`, port: addr.port, logs, stop: () => app.shutdown('test') };
  }
}

async function http(base, method, path, { body, token, headers } = {}) {
  const res = await fetch(base + path, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null; const text = await res.text();
  try { json = JSON.parse(text); } catch { /* no es JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(base) {
  const r = await http(base, 'POST', '/api/master/login', { body: { password: PASSWORD } });
  if (r.status !== 200) throw new Error('login falló: ' + r.status);
  return r.json.operatorToken;
}

async function createSession(base, opToken) {
  const r = await http(base, 'POST', '/api/sessions', { token: opToken, body: {} });
  if (r.status !== 201) throw new Error('crear sesión falló: ' + r.status + ' ' + r.text);
  return r.json;
}

class Client {
  constructor(url, { origin, headers } = {}) {
    this.msgs = []; this.waiters = []; this.closed = null; this.opened = false;
    this.ws = new WebSocket(url, { origin, headers });
    this.ws.on('open', () => { this.opened = true; });
    this.ws.on('message', d => {
      let m; try { m = JSON.parse(d.toString()); } catch { m = { type: '__raw', raw: d.toString() }; }
      this.msgs.push(m); this._flush();
    });
    this.ws.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; this._flush(); });
    this.ws.on('error', e => { this.error = e; this._flush(); });
    this.ws.on('unexpected-response', (req, res) => { this.closed = { code: 'HTTP', status: res.statusCode }; this._flush(); });
  }
  open() { return new Promise((res, rej) => { if (this.opened) return res(this); this.ws.once('open', () => res(this)); this.ws.once('error', rej); this.ws.once('unexpected-response', (q, r) => rej(Object.assign(new Error('HTTP ' + r.statusCode), { status: r.statusCode }))); }); }
  send(obj) { this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  _flush() {
    for (const w of [...this.waiters]) {
      const i = this.msgs.findIndex(w.pred);
      if (i >= 0) { const [m] = this.msgs.splice(i, 1); this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.t); w.res(m); }
      else if (this.closed && w.rejectOnClose) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.t); w.rej(new Error('cerrado ' + JSON.stringify(this.closed) + ' mientras esperaba ' + w.what)); }
    }
  }
  waitFor(pred, timeout = 3000, what = 'mensaje') {
    const p = typeof pred === 'string' ? (m => m.type === pred) : pred;
    const i = this.msgs.findIndex(p);
    if (i >= 0) return Promise.resolve(this.msgs.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const w = { pred: p, res, rej, what: typeof pred === 'string' ? pred : what, rejectOnClose: true };
      w.t = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error('timeout esperando ' + w.what + ' (recibidos: ' + this.msgs.map(m => m.type).join(',') + ')')); }, timeout);
      this.waiters.push(w);
    });
  }
  waitClose(timeout = 3000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout esperando cierre')), timeout); this.ws.once('close', () => { clearTimeout(t); res(this.closed); }); });
  }
  close() { try { this.ws.close(); } catch { /* ya cerrado */ } }
  terminate() { try { this.ws.terminate(); } catch { /* ya cerrado */ } }
}

async function joinPublic(url, sessionId, deviceId, extra = {}) {
  const c = await new Client(url, extra.client).open();
  c.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId, deviceId, ...(extra.hello || {}) });
  c.welcome = await c.waitFor('welcome');
  return c;
}

async function joinMaster(url, sessionId, token) {
  const c = await new Client(url).open();
  c.send({ protocolVersion: 1, type: 'hello', role: 'master', sessionId, token });
  c.welcome = await c.waitFor('welcome');
  return c;
}

// En Windows, ráfagas de más de ~230 conexiones TCP simultáneas contra loopback son rechazadas por el SO (medido con un servidor net vacío);
// por eso las pruebas masivas conectan por lotes. En Linux (Render) el límite es la cola de aceptación (LISTEN_BACKLOG / somaxconn).
async function joinMany(url, sessionId, n, extra = {}, batch = 100, offset = 0) {
  const out = [];
  for (let i = 0; i < n; i += batch) {
    out.push(...await Promise.all(Array.from({ length: Math.min(batch, n - i) }, (_, k) => joinPublic(url, sessionId, dev(offset + i + k + 1), extra))));
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dev = n => 'device-' + String(n).padStart(6, '0');

module.exports = { joinMany, startServer, http, login, createSession, Client, joinPublic, joinMaster, sleep, dev, PASSWORD };
