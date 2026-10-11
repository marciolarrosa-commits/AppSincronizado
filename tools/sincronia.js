'use strict';
// Banco de medición de SINCRONÍA (Chrome real). Lanza N teléfonos con: reloj local DESFASADO (±skew), latencia de bajada y de subida DISTINTAS (asimetría),
// jitter por mensaje y momentos de ingreso ESCALONADOS (antes de la orden y a mitad de la secuencia). Envía una secuencia R→G→B (1 s cada color, corte seco)
// y registra en cada teléfono el instante REAL (reloj del equipo, no el desfasado) de cada cambio de color; lo compara con el instante teórico
// (executeAt + acumulado de la secuencia) que fija el servidor.
//
//   node tools/sincronia.js [--phones 12] [--seed 1] [--skew 20000] [--down 20-150] [--up 20-150] [--jitter 40] [--secs 14] [--json salida.json]
//
// Mismo equipo => reloj del servidor = reloj real: el error medido es el del algoritmo (reloj estimado, planificación del dibujo, colas), NO el de relojes distintos
// entre equipos ni el de pantallas distintas. Resultados e interpretación: docs/SINCRONIZACION.md.
const fs = require('fs');
const path = require('path');
const { startServer, login, createSession, joinMaster, sleep } = require('../test/helpers');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const range = (s, d) => { const [a, b] = String(s || d).split('-').map(Number); return [a, b === undefined ? a : b]; };
const CLI = require.main === module;
const argvOpts = () => ({ phones: Number(arg('phones', 12)), seed: Number(arg('seed', 1)), skew: Number(arg('skew', 20000)), down: range(arg('down'), '20-150'), up: range(arg('up'), '20-150'), jitter: Number(arg('jitter', 40)), secs: Number(arg('secs', 14)), detalle: process.argv.includes('--detalle'), json: arg('json') });
const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));


// Se ejecuta en la página ANTES que remote.js: desfasa los relojes, envuelve el WebSocket (latencias/jitter) y registra cada cambio de color con el reloj REAL.
function instrumentar(cfg) {
  const realPerf = performance.now.bind(performance); const realDate = Date.now.bind(Date);
  window.__real = () => realDate();
  // performance.now() de un navegador real es SIEMPRE ≥ 0 (origen = carga de la página): se desfasa solo hacia adelante. La hora de pared (Date.now) sí puede estar
  // desfasada en cualquier sentido, pero el algoritmo no la usa para sincronizar.
  performance.now = () => realPerf() + Math.abs(cfg.skew); Date.now = () => realDate() + cfg.skew;
  const Native = window.WebSocket;
  class W {
    constructor(u) {
      this._ws = new Native(u);
      this._ws.onopen = e => this.onopen && this.onopen(e);
      this._ws.onclose = e => this.onclose && this.onclose(e);
      this._ws.onerror = e => this.onerror && this.onerror(e);
      this._ws.onmessage = e => setTimeout(() => this.onmessage && this.onmessage(e), cfg.down + Math.random() * cfg.jitter);
    }
    send(d) { setTimeout(() => { try { this._ws.send(d); } catch (x) { /* cerrado */ } }, cfg.up + Math.random() * cfg.jitter); }
    close(c, r) { this._ws.close(c, r); }
    get readyState() { return this._ws.readyState; }
  }
  W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3; window.WebSocket = W;
  window.__log = []; window.__clk = [];
  const est = () => { const R = window.DestelloRemote; return R && R._serverNow ? R._serverNow() : null; };
  document.addEventListener('DOMContentLoaded', () => {
    const light = document.getElementById('remote-light');
    new MutationObserver(() => window.__log.push([window.__real(), light.style.backgroundColor, est()])).observe(light, { attributes: true, attributeFilter: ['style'] });
    setInterval(() => { const R = window.DestelloRemote; if (R && R._state && R._state.connected) window.__clk.push([window.__real(), est() - window.__real()]); }, 50);   // error del reloj estimado
  });
}
const rgb = s => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s || ''); return m ? [+m[1], +m[2], +m[3]] : null; };
const cls = c => { if (!c) return '?'; const P = { R: [255, 0, 0], G: [0, 255, 0], B: [0, 0, 255], K: [0, 0, 0] }; let b = '?', d = 80; for (const [k, v] of Object.entries(P)) { const x = Math.abs(c[0] - v[0]) + Math.abs(c[1] - v[1]) + Math.abs(c[2] - v[2]); if (x < d) { d = x; b = k; } } return b; };
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10; };

async function run(options = {}) {
  if (!CHROME) throw new Error('No hay Chrome/Edge (CHROME_PATH).');
  const o = { ...argvOpts(), ...options };
  const PHONES = o.phones, SEED = o.seed, SKEW = o.skew, [DOWN0, DOWN1] = o.down, [UP0, UP1] = o.up, JITTER = o.jitter, SECS = o.secs;
  let seed = SEED * 2654435761 >>> 0; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const between = (a, b) => a + rnd() * (b - a);
  const srv = await startServer({ wsConnectPerMinPerIp: 1e6, httpPerMin: 1e6, publicMsgPerSec: 50, publicMsgBurst: 100 });
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const T0 = Date.now(); const CMD_AT = 5000;                                   // la orden sale a los 5 s del inicio
  const SEQ = [['R', '#FF0000', 1000], ['G', '#00FF00', 1000], ['B', '#0000FF', 1000]]; const CYCLE = 3000;

  // perfiles: ingresos escalonados: ~1/3 ANTES de la orden y el resto DURANTE la secuencia (hasta +7 s)
  const phones = Array.from({ length: PHONES }, (_, i) => ({
    id: i + 1, skew: Math.round(between(-SKEW, SKEW)), down: Math.round(between(DOWN0, DOWN1)), up: Math.round(between(UP0, UP1)), jitter: JITTER,
    joinAt: i < PHONES / 3 ? Math.round(between(500, CMD_AT - 2500)) : Math.round(between(CMD_AT - 500, CMD_AT + 7000))
  }));
  const state = phones.map(p => ({ ...p, page: null, joinedReal: 0 }));
  async function launch(p) {
    await sleep(Math.max(0, T0 + p.joinAt - Date.now()));
    const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(instrumentar, { skew: p.skew, down: p.down, up: p.up, jitter: p.jitter });
    p.joinedReal = Date.now(); p.page = page; await page.goto(s.joinUrl);
  }
  const launching = state.map(launch);
  await sleep(CMD_AT);
  master.send({ protocolVersion: 1, type: 'command', commandId: 'bench-seq-0001', leadMs: 3000, payload: { effect: 'sequence', steps: SEQ.map(([, c, h]) => ({ color: c, holdMs: h })), fadeMs: 0, durationMs: 0 } });
  const ack = await master.waitFor(m => m.type === 'ack', 5000); const EX = ack.executeAt;
  await Promise.all(launching);
  await sleep(Math.max(0, EX + SECS * 1000 - Date.now()));

  const expectedAt = r => { const pos = ((r - EX) % CYCLE + CYCLE) % CYCLE; let acc = 0; for (const [k, , h] of SEQ) { if (pos < acc + h) return k; acc += h; } return SEQ[0][0]; };
  const nominal = (color, r) => { const idx = SEQ.findIndex(x => x[0] === color); if (idx < 0) return null; let off = SEQ.slice(0, idx).reduce((a, x) => a + x[2], 0); const k = Math.round((r - EX - off) / CYCLE); return EX + off + k * CYCLE; };
  const end = EX + SECS * 1000; const rows = []; const allErr = []; const clockRows = []; const paintAll = [];
  for (const p of state) {
    const raw = await p.page.evaluate(() => ({ log: window.__log, clk: window.__clk }));
    const log = raw.log.map(([t, c]) => [t, cls(rgb(c))]); const clk = raw.clk;
    // error del RELOJ estimado: al conectar, tiempo hasta converger (|e| ≤ 25 ms de forma sostenida) y error en régimen
    const tail = clk.slice(-40).map(x => x[1]).sort((a, b) => a - b); const finalErr = tail.length ? tail[Math.floor(tail.length / 2)] : 0;      // sesgo de régimen de ESTE teléfono (asimetría de su red)
    let conv = null; for (let i = 0; i < clk.length; i++) { if (clk.slice(i).every(x => Math.abs(x[1] - finalErr) <= 25)) { conv = clk[i][0] - clk[0][0]; break; } }
    const steadyAll = clk.filter(x => x[0] >= clk[0][0] + 2000).map(x => x[1]);
    const steady = steadyAll.map(x => Math.abs(x)); const wobble = steadyAll.length ? Math.max(...steadyAll) - Math.min(...steadyAll) : 0;
    // retraso de DIBUJO: instante en que se pinta el cambio según su reloj estimado menos el instante teórico (excluye el error del reloj)
    const paint = raw.log.filter(x => x[2] != null && x[0] >= EX).map(([r, c, e]) => { const k = cls(rgb(c)); if (k === 'K' || k === '?') return null; const nb = nominal(k, e); return Math.abs(e - nb) <= 500 ? e - nb : null; }).filter(x => x != null);
    const errs = [], spurious = [];
    for (const [r, c] of log) { if (r < EX || c === 'K' || c === '?') continue; const nb = nominal(c, r); const e = r - nb; if (Math.abs(e) <= 500) errs.push(e); else spurious.push(Math.round(e)); }
    // tiempo con color incorrecto (desde que muestra su primer color hasta el final), reconstruido a pasos de 5 ms
    const firstColor = log.find(([r, c]) => r >= EX - 100 && c !== 'K' && c !== '?'); let wrongMs = 0, total = 0, worstRun = 0, run = 0;
    if (firstColor) {
      const seg = log.filter(([r]) => r >= firstColor[0]); let li = 0, cur = seg[0][1];
      for (let t = firstColor[0]; t < end; t += 5) { while (li + 1 < seg.length && seg[li + 1][0] <= t) { li++; cur = seg[li][1]; } total += 5; if (cur !== expectedAt(t) && t >= EX) { wrongMs += 5; run += 5; worstRun = Math.max(worstRun, run); } else run = 0; }
    }
    const firstCorrect = log.find(([r, c]) => r >= p.joinedReal && c === expectedAt(r) && c !== 'K');
    clockRows.push({ initErr: clk.length ? Math.round(clk[0][1]) : null, conv, sesgo: Math.round(finalErr), steadyMax: steady.length ? Math.round(Math.max(...steady)) : null, wobble: Math.round(wobble) }); paintAll.push(...paint);
    rows.push({ id: p.id, errInicialRelojMs: clk.length ? Math.round(clk[0][1]) : null, convergeMs: conv, errRelojRegimenMaxMs: steady.length ? Math.round(Math.max(...steady)) : null, skewMs: p.skew, downMs: p.down, upMs: p.up, asimetria: Math.abs(p.down - p.up), ingresoRelativoAOrden: p.joinAt - CMD_AT,
      cambios: errs.length, errMedianoMs: pct(errs, 0.5), errMaxAbsMs: errs.length ? Math.round(Math.max(...errs.map(Math.abs))) : null, cambiosFueraDeLugar: spurious.length, incorrectoMs: wrongMs, rachaIncorrectaMaxMs: worstRun,
      hastaPrimerColorCorrectoMs: firstCorrect ? firstCorrect[0] - p.joinedReal : null });
    allErr.push(...errs);
  }
  const abs = allErr.map(Math.abs);
  const num = a => a.filter(x => x != null);
  const reloj = {
    errorInicialAbsMs: { p50: pct(num(clockRows.map(r => r.initErr)).map(Math.abs), 0.5), max: Math.max(...num(clockRows.map(r => Math.abs(r.initErr)))) },
    convergenciaMs: { p50: pct(num(clockRows.map(r => r.conv)), 0.5), max: Math.max(...num(clockRows.map(r => r.conv))), sinConvergir: clockRows.filter(r => r.conv == null).length },
    sesgoRegimenAbsMs: { p50: pct(clockRows.map(r => Math.abs(r.sesgo)), 0.5), p95: pct(clockRows.map(r => Math.abs(r.sesgo)), 0.95), max: Math.max(...clockRows.map(r => Math.abs(r.sesgo))) },
    oscilacionEnRegimenMs: { p50: pct(clockRows.map(r => r.wobble), 0.5), max: Math.max(...clockRows.map(r => r.wobble)) }
  };
  const dibujo = { retrasoMs: { p50: pct(paintAll, 0.5), p95: pct(paintAll, 0.95), max: paintAll.length ? Math.round(Math.max(...paintAll)) : null, min: paintAll.length ? Math.round(Math.min(...paintAll)) : null } };
  const resumen = {
    reloj, dibujo,
    telefonos: PHONES, cambiosMedidos: allErr.length, errorAbsMs: { p50: pct(abs, 0.5), p95: pct(abs, 0.95), p99: pct(abs, 0.99), max: Math.round(Math.max(...abs)) }, errorConSignoMs: { p5: pct(allErr, 0.05), p50: pct(allErr, 0.5), p95: pct(allErr, 0.95) },
    dispersionEntreTelefonosMs: Math.round((pct(allErr, 0.95) - pct(allErr, 0.05)) * 10) / 10,
    cambiosFueraDeLugarTotal: rows.reduce((a, r) => a + r.cambiosFueraDeLugar, 0), tiempoIncorrectoMedioMs: Math.round(rows.reduce((a, r) => a + r.incorrectoMs, 0) / rows.length), rachaIncorrectaMaxMs: Math.max(...rows.map(r => r.rachaIncorrectaMaxMs)),
    hastaPrimerColorCorrectoMs: { p50: pct(rows.map(r => r.hastaPrimerColorCorrectoMs).filter(x => x != null), 0.5), max: Math.max(...rows.map(r => r.hastaPrimerColorCorrectoMs || 0)) }
  };
  await browser.close(); master.ws.close(); await srv.stop();
  return { parametros: { PHONES, SEED, SKEW, down: [DOWN0, DOWN1], up: [UP0, UP1], JITTER }, resumen, rows };
}

module.exports = { run };
if (CLI) {
  run().then(r => {
    console.log(JSON.stringify({ parametros: r.parametros, resumen: r.resumen }, null, 1));
    const o = argvOpts(); if (o.detalle) console.table(r.rows);
    if (o.json) fs.writeFileSync(path.resolve(o.json), JSON.stringify({ resumen: r.resumen, rows: r.rows }, null, 1));
  }).catch(e => { console.error(e); process.exit(1); });
}
