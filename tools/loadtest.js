#!/usr/bin/env node
'use strict';
/**
 * Herramienta de carga de Destello Sync (independiente de la aplicación pública: solo usa la librería `ws`).
 * Simula N teléfonos por WebSocket, un Master que emite órdenes y, opcionalmente, una reconexión masiva.
 *
 *   node tools/loadtest.js --spawn --clients 1000 --commands 5 --storm 1
 *   node tools/loadtest.js --spawn --instances 2 --spawn-redis --clients 5000     (requiere REDIS_SERVER=/ruta/redis-server)
 *   node tools/loadtest.js --spawn --env CLUSTER_WORKERS=4 --workers 4 --spawn-redis --clients 5000
 *   node tools/loadtest.js --base https://mi-servicio.onrender.com --password ... --clients 500   (SOLO con autorización del dueño del servicio)
 *
 * QUÉ MIDE (y qué NO):
 *  - "Distribución": serverTimestamp de la orden -> recepción en el cliente simulado (mismo equipo => mismo reloj).
 *  - "Aplicación simulada": retraso del TEMPORIZADOR que dispara en executeAt dentro del generador. NO es una pantalla real ni demuestra que un
 *    efecto visual se haya mostrado: mide jitter del generador/event loop. Las "confirmaciones" (`applied`) las envían los clientes simulados.
 *  - Un ACK del servidor al Master significa "aceptada y publicada", no "mostrada".
 *  - Métricas del servidor: se consultan TODAS las instancias (y workers) por separado y se AGREGAN sumando contadores acumulados (una vez por
 *    instancia) y sumando los buckets de los histogramas (los percentiles no se promedian). Se informa el detalle por instancia.
 *  - La configuración efectiva del almacenamiento (memoria/Redis) se lee de cada servidor, no del argumento de línea de comandos.
 *  - Se mide la salud del propio generador (lag del event loop): si está saturado, las métricas de aplicación simulada no son concluyentes.
 */
const { spawn } = require('child_process');
const { monitorEventLoopDelay } = require('perf_hooks');
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const args = (() => {
  const a = process.argv.slice(2); const o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    if (i + 1 >= a.length || a[i + 1].startsWith('--')) o[k] = true; else o[k] = a[++i];
  }
  return o;
})();

const CLIENTS = Number(args.clients || 100);
const RATE = Number(args.rate || 400);                    // conexiones nuevas por segundo (rampa)
const COMMANDS = Number(args.commands || 5);
const INTERVAL = Number(args.interval || 1500);          // ms entre órdenes
const LEAD = Number(args.lead || 1500);
const STORM = Number(args.storm || 0);                    // fracción 0..1 de clientes que se cortan y reconectan a la vez
const PASSWORD = args.password || process.env.MASTER_PASSWORD || 'load-test-password-123456';
const SPAWN = Boolean(args.spawn);
const PORT = Number(args.port || 0);
const OUT = args.out || null;
const LABEL = args.label || `${CLIENTS}c`;
const EXTRA_ENV = args.env ? Object.fromEntries(String(args.env).split(',').map(s => s.split('='))) : {};
let REDIS_URL = args.redis || '';
const INSTANCES = Number(args.instances || 1);
const WORKERS = Number(args.workers || 1);               // procesos por instancia (CLUSTER_WORKERS) para completar el muestreo de métricas
const REDIS_REQUESTED = Boolean(args['spawn-redis'] || args.redis);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const round1 = v => Math.round(v * 10) / 10;
function pct(arr, p) { if (!arr.length) return null; const s = Float64Array.from(arr).sort(); return round1(s[Math.min(s.length - 1, Math.floor(s.length * p))]); }
function summary(arr) { return { n: arr.length, p50: pct(arr, 0.5), p95: pct(arr, 0.95), p99: pct(arr, 0.99), max: arr.length ? round1(arr.reduce((m, v) => v > m ? v : m, -Infinity)) : null }; }
function histQuantile(edges, counts, q, max) {
  const n = counts.reduce((a, b) => a + b, 0); if (!n) return null;
  const target = Math.ceil(n * q); let acc = 0;
  for (let i = 0; i < counts.length; i++) { acc += counts[i]; if (acc >= target) return i < edges.length ? edges[i] : max; }
  return max;
}

async function httpJson(base, method, p, { body, token } = {}) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* texto */ }
  return { status: r.status, json: j, text: t };
}

// ---------------------------------------------------------------------------------------------- servidores locales
const PREFIX = 'lt:' + Date.now() + ':';       // el MISMO prefijo para todas las instancias (comparten el estado)
async function startRedisIfRequested(procs) {
  if (!args['spawn-redis']) return;
  const bin = process.env.REDIS_SERVER; if (!bin) throw new Error('--spawn-redis requiere la variable REDIS_SERVER');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(bin, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  procs.push(p); REDIS_URL = 'redis://127.0.0.1:' + port; await sleep(1500);
}

async function startServers() {
  const procs = []; const bases = [];
  await startRedisIfRequested(procs);
  for (let i = 0; i < INSTANCES; i++) {
    // Entorno CONTROLADO: no se hereda REDIS_URL/CLUSTER_WORKERS del shell (si no, la prueba podría usar Redis sin que el informe lo sepa).
    const inherited = { ...process.env }; delete inherited.REDIS_URL; delete inherited.CLUSTER_WORKERS; delete inherited.REDIS_PREFIX;
    const env = {
      ...inherited, PORT: String(PORT ? PORT + i : 0), HOST: '127.0.0.1', MASTER_PASSWORD: PASSWORD, NODE_ENV: 'development', LOG_LEVEL: 'info',
      WS_CONNECT_PER_MIN_PER_IP: '100000000', HTTP_RATE_PER_MIN: '100000000', BAD_JOIN_PER_MIN_PER_IP: '100000000', LOGIN_RATE_PER_MIN: '1000', PRE_HELLO_MAX_PER_IP: '1000000',
      MAX_CONNECTIONS: String(Math.max(20000, CLIENTS * 2)), INSTANCE_ID: 'load-' + i, PUBLIC_MSG_PER_SEC: '50', PUBLIC_MSG_BURST: '200',
      ...(REDIS_URL ? { REDIS_URL, REDIS_PREFIX: PREFIX } : {}), ...EXTRA_ENV
    };
    const nodeArgs = args['node-args'] ? String(args['node-args']).split(' ') : [];
    const p = spawn(process.execPath, [...nodeArgs, path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let port = 0; let buf = '';
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('el servidor no arrancó')), 20000);
      p.stdout.on('data', d => { buf += d; const m = /"port":(\d+)/.exec(buf); if (m && !port) { port = Number(m[1]); clearTimeout(t); resolve(); } });
      p.stderr.on('data', d => process.stderr.write('[srv] ' + d));
      p.on('exit', c => { if (!port) reject(new Error('servidor terminó con código ' + c)); });
    });
    procs.push(p); bases.push(`http://127.0.0.1:${port}`);
  }
  return { procs, bases };
}

// ---------------------------------------------------------------------------------------------- agregación de métricas del servidor
/** Estado por proceso de servidor (clave = id de instancia que informa el propio servidor). Cada sondeo reemplaza al anterior del MISMO proceso. */
function createServerView() {
  const byInstance = new Map();    // instanceId -> {base, first, last, peaks}
  return {
    byInstance,
    record(base, status) {
      const id = status.instance;
      let e = byInstance.get(id);
      const g = status.metrics.gauges;
      if (!e) { e = { base, first: status, peaks: { rssMB: 0, heapMB: 0, cpu: 0, lagP99: 0, bufferedKB: 0, connections: 0 }, polls: 0 }; byInstance.set(id, e); }
      e.last = status; e.polls++;
      e.peaks.rssMB = Math.max(e.peaks.rssMB, Math.round((g.memory_rss_bytes || 0) / 1048576));
      e.peaks.heapMB = Math.max(e.peaks.heapMB, Math.round((g.memory_heap_used_bytes || 0) / 1048576));
      e.peaks.cpu = Math.max(e.peaks.cpu, g.cpu_percent || 0);
      e.peaks.lagP99 = Math.max(e.peaks.lagP99, g.event_loop_lag_p99_ms || 0);
      e.peaks.bufferedKB = Math.max(e.peaks.bufferedKB, Math.round((g.ws_buffered_bytes || 0) / 1024));
      e.peaks.connections = Math.max(e.peaks.connections, status.hub.connections || 0);
    },
    /** Marca el punto de partida de los contadores acumulados de cada proceso. */
    mark() { for (const e of byInstance.values()) e.mark = e.last; },
    aggregate(sinceMark) {
      const counters = {}; const per = [];
      const hist = {};
      for (const [id, e] of byInstance) {
        const c1 = e.last.metrics.counters; const c0 = sinceMark && e.mark ? e.mark.metrics.counters : {};
        const delta = {};
        for (const k of Object.keys(c1)) { delta[k] = c1[k] - (c0[k] || 0); counters[k] = (counters[k] || 0) + delta[k]; }
        for (const [name, h] of Object.entries(e.last.metrics.latency)) {
          const a = hist[name] || (hist[name] = { edges: h.buckets.edges, counts: new Array(h.buckets.counts.length).fill(0), n: 0, max: 0 });
          h.buckets.counts.forEach((v, i) => { a.counts[i] += v; }); a.n += h.n; a.max = Math.max(a.max, h.max || 0);
        }
        per.push({ instance: id, base: e.base, polls: e.polls, store: e.last.store, health: e.last.health.status, healthReasons: e.last.health.reasons, peaks: e.peaks,
          connectionsNow: e.last.hub.connections, publicNow: e.last.hub.public, counters: sinceMark ? delta : e.last.metrics.counters });
      }
      const latency = Object.fromEntries(Object.entries(hist).map(([k, a]) => [k, { n: a.n, p50: histQuantile(a.edges, a.counts, 0.5, a.max), p95: histQuantile(a.edges, a.counts, 0.95, a.max), p99: histQuantile(a.edges, a.counts, 0.99, a.max), max: a.max }]));
      const peaks = per.reduce((m, p) => ({ rssMB: Math.max(m.rssMB, p.peaks.rssMB), cpu: Math.max(m.cpu, p.peaks.cpu), lagP99: Math.max(m.lagP99, p.peaks.lagP99), bufferedKB: Math.max(m.bufferedKB, p.peaks.bufferedKB) }), { rssMB: 0, cpu: 0, lagP99: 0, bufferedKB: 0 });
      const totalRss = per.reduce((n, p) => n + p.peaks.rssMB, 0);
      return { instances: per.length, counters, latencyMergedFromBuckets: latency, peaks: { ...peaks, rssMBSumAcrossProcesses: totalRss }, perInstance: per };
    }
  };
}

(async () => {
  const startedAt = now();
  const report = { label: LABEL, startedAt: new Date(startedAt).toISOString(), node: process.version, platform: `${process.platform} ${os.release()}`, cpus: os.cpus().length,
    params: { CLIENTS, RATE, COMMANDS, INTERVAL, LEAD, STORM, INSTANCES, WORKERS, redisRequestedByFlags: REDIS_REQUESTED, extraEnv: Object.keys(EXTRA_ENV) } };
  let servers = null; let bases = [];
  if (SPAWN) { servers = await startServers(); bases = servers.bases; } else bases = [String(args.base || 'http://127.0.0.1:10000').replace(/\/+$/, '')];
  const base0 = bases[0];
  const wsOf = b => b.replace(/^http/, 'ws') + '/ws';

  const login = await httpJson(base0, 'POST', '/api/master/login', { body: { password: PASSWORD } });
  if (login.status !== 200) throw new Error('login falló: ' + login.status);
  const op = login.json.operatorToken;
  const sess = (await httpJson(base0, 'POST', '/api/sessions', { token: op, body: {} })).json;
  const sid = sess.sessionId;
  report.sessionId = sid;

  // ---- salud del generador (si está saturado, las métricas de aplicación simulada no son concluyentes)
  const genLoop = monitorEventLoopDelay({ resolution: 10 }); genLoop.enable();
  let genCpuPeak = 0; let lastCpu = process.cpuUsage(); let lastT = now();
  const genTimer = setInterval(() => { const c = process.cpuUsage(lastCpu); const t = now(); genCpuPeak = Math.max(genCpuPeak, round1(((c.user + c.system) / 1000) / (t - lastT) * 100)); lastCpu = process.cpuUsage(); lastT = t; }, 2000);

  // ---- Master
  const master = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsOf(base0), { origin: base0 });
    ws.on('open', () => ws.send(JSON.stringify({ protocolVersion: 1, type: 'hello', role: 'master', sessionId: sid, token: sess.masterToken })));
    ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'welcome') resolve(ws); });
    ws.on('error', reject);
  });
  const acks = new Map(); const masterMsgs = []; const masterErrors = [];
  master.on('message', d => { const m = JSON.parse(d); masterMsgs.push(m); if (m.type === 'ack') acks.set(m.stateVersion, m); if (m.type === 'error') masterErrors.push(m.code); });

  // ---- Clientes simulados
  const stat = { attempted: 0, established: 0, failed: 0, closedUnexpected: 0, closedByTool: 0, errors: 0, recovered: 0, duplicatesDropped: 0, outOfOrder: 0, appliedReportsSent: 0, welcomeReceived: 0 };
  const rejected = {};
  const connectMs = []; const latency = []; const applyDev = []; const recvByVersion = new Map(); const reconnectMs = [];
  const clients = [];
  let phase = 'ramp'; let currentlyReady = 0;

  function makeClient(idx, base, isReconnect) {
    const c = { idx, base, ws: null, ready: false, lastVersion: 0, dead: false };
    const t0 = now(); stat.attempted++;
    const ws = new WebSocket(wsOf(base), { origin: base, perMessageDeflate: false });
    c.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: sid, deviceId: 'load-' + String(idx).padStart(7, '0'), reconnect: Boolean(isReconnect), resumeVersion: c.lastVersion })));
    ws.on('message', raw => {
      const recvAt = now();
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'welcome') {
        c.ready = true; stat.established++; stat.welcomeReceived++; currentlyReady++;
        if (isReconnect) { stat.recovered++; reconnectMs.push(recvAt - t0); } else connectMs.push(recvAt - t0);
        c.lastVersion = m.state.stateVersion; c.welcomeVersion = m.state.stateVersion;
      } else if (m.type === 'state') {
        if (m.stateVersion === c.lastVersion) { stat.duplicatesDropped++; return; }
        if (m.stateVersion < c.lastVersion) { stat.outOfOrder++; return; }
        c.lastVersion = m.stateVersion;
        recvByVersion.set(m.stateVersion, (recvByVersion.get(m.stateVersion) || 0) + 1);
        latency.push(recvAt - m.serverTimestamp);
        const wait = m.executeAt - recvAt;
        setTimeout(() => {                                       // aplicación SIMULADA: temporizador en executeAt
          const dev = now() - m.executeAt; applyDev.push(dev);
          if (m.ackRate > 0 && Math.random() < m.ackRate && ws.readyState === 1) { stat.appliedReportsSent++; ws.send(JSON.stringify({ protocolVersion: 1, type: 'applied', commandId: m.commandId, stateVersion: m.stateVersion, deviationMs: dev, receiveLeadMs: wait })); }
        }, Math.max(0, wait));
      } else if (m.type === 'error') { rejected[m.code] = (rejected[m.code] || 0) + 1; }
    });
    ws.on('unexpected-response', (rq, rs) => { stat.failed++; rejected['HTTP_' + rs.statusCode] = (rejected['HTTP_' + rs.statusCode] || 0) + 1; });
    ws.on('error', e => { stat.errors++; if (!c.ready) { stat.failed++; rejected[e.code || 'ERR'] = (rejected[e.code || 'ERR'] || 0) + 1; } });
    ws.on('close', () => { if (c.ready) currentlyReady--; if (c.ready && !c.dead && phase !== 'closing') stat.closedUnexpected++; c.ready = false; });
    return c;
  }

  // ---- sondeo de TODAS las instancias/procesos
  const view = createServerView();
  async function poll() {
    for (const b of bases) {
      // con CLUSTER_WORKERS la misma URL responde con un worker al azar: varios sondeos hasta ver a todos
      const tries = WORKERS > 1 ? WORKERS * 6 : 1;
      for (let i = 0; i < tries; i++) {
        try { const r = await httpJson(b, 'GET', '/api/admin/status', { token: op }); if (r.status === 200) view.record(b, r.json); } catch { /* servidor ocupado */ }
      }
    }
  }
  const poller = setInterval(poll, 2000);

  // ---- 1) Rampa de conexiones
  const tRamp = now();
  const per = Math.max(1, Math.round(RATE / 10));                 // lotes cada 100 ms (el SO Windows rechaza ráfagas de ~230+ conexiones)
  for (let i = 0; i < CLIENTS; i += per) {
    for (let k = i; k < Math.min(CLIENTS, i + per); k++) clients.push(makeClient(k, bases[k % bases.length], false));
    await sleep(100);
  }
  const settleEnd = now() + 30000;
  while (stat.established + stat.failed < CLIENTS && now() < settleEnd) await sleep(100);
  report.rampMs = now() - tRamp;
  await sleep(2500);                                               // deja que la presencia se propague
  await poll();
  view.mark();                                                     // punto de partida de los contadores acumulados para la ventana de órdenes
  report.connections = { attempted: stat.attempted, established: stat.established, failed: stat.failed, rejectedByReason: { ...rejected }, connectMs: summary(connectMs) };

  // ---- 2) Órdenes del Master
  phase = 'commands';
  const palette = ['#FF3B30', '#0A84FF', '#34C759', '#FFD400', '#AF52DE', '#FFFFFF', '#FF9F1C'];
  const tCmd = now(); const acceptMs = [];
  const expectedReady = currentlyReady;
  for (let k = 0; k < COMMANDS; k++) {
    const t = now();
    master.send(JSON.stringify({ protocolVersion: 1, type: 'command', leadMs: LEAD, payload: { effect: 'solid', color: palette[k % palette.length], fadeMs: 0 } }));
    const v = k + 1; const end = now() + 8000;
    while (!acks.has(v) && now() < end) await sleep(5);
    if (acks.has(v)) acceptMs.push(now() - t);
    await sleep(INTERVAL);
  }
  await sleep(LEAD + 2500);
  await poll();
  const cmdSeconds = (now() - tCmd) / 1000;
  const delivered = [...Array(COMMANDS)].map((_, i) => recvByVersion.get(i + 1) || 0);
  const totalDelivered = delivered.reduce((a, b) => a + b, 0);
  const aggCmd = view.aggregate(true);
  const lastStats = [...masterMsgs].reverse().find(m => m.type === 'stats' && m.responded);
  report.commands = {
    sent: COMMANDS, acceptedByServer: acks.size, rejectedByServer: masterErrors.length, acceptMs: summary(acceptMs),
    deliveredPerCommand: delivered, expectedPerCommand: expectedReady, totalDelivered, totalExpected: expectedReady * COMMANDS,
    lost: expectedReady * COMMANDS - totalDelivered, duplicatesDroppedByClients: stat.duplicatesDropped, outOfOrderDropped: stat.outOfOrder,
    lossPct: expectedReady ? round1((1 - totalDelivered / (expectedReady * COMMANDS)) * 1000) / 10 : null,
    distributionLatencyMs: summary(latency),
    simulatedApplyDeviationMs: { ...summary(applyDev.map(Math.abs)), note: 'jitter del temporizador del generador; NO es una pantalla real' },
    appliedReportsSentBySimulatedClients: stat.appliedReportsSent,
    masterStatsAggregatedByServer: lastStats ? { responded: lastStats.responded, onTimePct: lastStats.onTimePct, p50: lastStats.deviationP50Ms, p95: lastStats.deviationP95Ms, p99: lastStats.deviationP99Ms, note: 'reportes de clientes simulados' } : null,
    windowSeconds: round1(cmdSeconds),
    serverMessagesOutDeltaAggregated: aggCmd.counters.messages_out || 0,
    serverMessagesPerSecond: Math.round((aggCmd.counters.messages_out || 0) / cmdSeconds),
    serverBytesOutDeltaAggregated: aggCmd.counters.bytes_out || 0
  };

  // ---- 3) Reconexión masiva
  if (STORM > 0) {
    phase = 'storm';
    const n = Math.round(clients.length * STORM);
    const victims = clients.slice(0, n);
    const before = currentlyReady; const recovered0 = stat.recovered;
    for (const c of victims) { c.dead = true; stat.closedByTool++; try { c.ws.terminate(); } catch { /* ya cerrado */ } }
    await sleep(500);
    const reconnectStart = now();
    // Igual que el cliente real: backoff con jitter (aquí, ventana de 8 s) para no reconectar todos en el mismo instante.
    await Promise.all(victims.map(async c => {
      await sleep(Math.random() * 8000);
      const nc = makeClient(c.idx, bases[c.idx % bases.length], true); nc.lastVersion = c.lastVersion; clients[c.idx] = nc;
    }));
    const end = now() + 60000;
    while (currentlyReady < before && now() < end) await sleep(100);
    const v = COMMANDS + 1; const exp2 = currentlyReady;
    master.send(JSON.stringify({ protocolVersion: 1, type: 'command', leadMs: LEAD, payload: { effect: 'solid', color: '#00C7BE', fadeMs: 0 } }));
    await sleep(LEAD + 2500);
    report.storm = { dropped: n, recovered: stat.recovered - recovered0, recoveryMs: now() - reconnectStart, reconnectMs: summary(reconnectMs), unexpectedClosesDuringStorm: stat.closedUnexpected,
      deliveredAfterRecovery: recvByVersion.get(v) || 0, expectedAfterRecovery: exp2, readyAfter: currentlyReady };
    await poll();
  }

  // ---- 4) Cierre y agregación final
  clearInterval(poller); clearInterval(genTimer);
  phase = 'closing';
  await poll();
  const finalAgg = view.aggregate(false);
  const effectiveKinds = [...new Set(finalAgg.perInstance.map(p => p.store && p.store.config ? p.store.config.kind : 'desconocido'))];
  report.server = {
    note: 'Contadores = suma de los acumulados de CADA proceso (una vez por proceso). Histogramas = suma de buckets. Picos = máximo entre procesos.',
    processesObserved: finalAgg.instances, processesExpected: bases.length * WORKERS,
    observedAllProcesses: finalAgg.instances >= bases.length * WORKERS,
    effectiveStore: effectiveKinds.length === 1 ? effectiveKinds[0] : 'MIXTO:' + effectiveKinds.join(','),
    redisRequestedByFlags: REDIS_REQUESTED,
    redisConfigsMasked: finalAgg.perInstance.map(p => (p.store && p.store.config && p.store.config.url) || null),
    storeMatchesRequest: (effectiveKinds.length === 1 && (effectiveKinds[0] === 'redis') === REDIS_REQUESTED) || !SPAWN,
    peaks: finalAgg.peaks, counters: finalAgg.counters, latencyMergedFromBuckets: finalAgg.latencyMergedFromBuckets,
    healthByInstance: finalAgg.perInstance.map(p => ({ instance: p.instance, health: p.health, reasons: p.healthReasons })),
    perInstance: finalAgg.perInstance
  };
  report.generator = { eventLoopLagP99Ms: round1(genLoop.percentile(99) / 1e6), eventLoopLagMaxMs: round1(genLoop.max / 1e6), cpuPeakPct: genCpuPeak, rssMB: Math.round(process.memoryUsage().rss / 1048576),
    saturated: genLoop.percentile(99) / 1e6 > 50, unexpectedCloses: stat.closedUnexpected, errors: stat.errors };
  report.clientsSummary = { ...stat };
  report.finishedAt = new Date().toISOString(); report.durationS = round1((now() - startedAt) / 1000);

  // ---- Veredicto contra los criterios de docs/CARGA.md (se evalúa automáticamente; no se "interpreta")
  const c = report.commands; const lat = c.distributionLatencyMs; const dev = c.simulatedApplyDeviationMs;
  const crit = {
    '1 conexiones >= 99,5 %': stat.established / CLIENTS >= 0.995 && !Object.keys(rejected).some(k => /^HTTP_5/.test(k)),
    '2 conexión p95<=1500 y p99<=3000 ms': report.connections.connectMs.p95 <= 1500 && report.connections.connectMs.p99 <= 3000,
    '3 pérdida <= 0,1 %': c.lossPct !== null && c.lossPct <= 0.1,
    '4 distribución p95<=250 y p99<=500 ms': lat.p95 <= 250 && lat.p99 <= 500,
    '5 aplicación simulada p99<=150 ms': dev.p99 !== null && dev.p99 <= 150,
    '6 servidor: lag p99<=100, sin heartbeat/slow/store errors, salud ok': report.server.peaks.lagP99 <= 100 && !(report.server.counters.heartbeat_timeouts) && !(report.server.counters.ws_slow_closed) && !(report.server.counters.store_errors) && report.server.healthByInstance.every(h => h.health === 'ok'),
    '7 corte masivo (si se pidió): >=99,5 % en <=30 s y orden posterior a todos': STORM > 0 ? (report.storm.recovered / report.storm.dropped >= 0.995 && report.storm.recoveryMs <= 30000 && report.storm.deliveredAfterRecovery / Math.max(1, report.storm.expectedAfterRecovery) >= 0.995) : 'no aplica'
  };
  const failed = Object.entries(crit).filter(([, v]) => v === false).map(([k]) => k);
  report.verdict = { criteria: crit, failed, result: failed.length ? 'NO APROBADA' : 'APROBADA',
    caveats: [
      ...(report.generator.saturated ? ['El generador estaba saturado (lag p99 > 50 ms): el criterio 5 y las latencias NO son concluyentes.'] : []),
      ...(!report.server.observedAllProcesses ? [`Solo se observaron ${report.server.processesObserved} de ${report.server.processesExpected} procesos del servidor: las métricas agregadas son parciales.`] : []),
      ...(!report.server.storeMatchesRequest ? ['La configuración efectiva del almacenamiento NO coincide con lo solicitado por los argumentos.'] : [])
    ] };

  for (const cl of clients) { try { cl.ws.terminate(); } catch { /* ya cerrado */ } }
  try { master.terminate(); } catch { /* ya cerrado */ }
  if (servers) for (const p of servers.procs) { p.kill(); }
  console.log(JSON.stringify(report, null, 2));
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); }
  setTimeout(() => process.exit(0), 300);
})().catch(e => { console.error('FALLO de la herramienta:', e); process.exit(1); });
