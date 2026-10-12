'use strict';
// SINCRONÍA (V3.4.0): estimación del reloj del servidor en el teléfono, simulación estadística de 60 000 teléfonos que se unen en momentos distintos,
// planificación exacta de los cambios de color y telemetría de calidad de reloj.
//  - Unidad: public/js/clock.js, public/js/effects.js (`next`), src/protocol.js (`rtt` del ping).
//  - Simulación: modelo de red explícito (NO es una medición de un estadio real).
//  - Integración: servidor + WebSocket reales (el ping con `rtt` alimenta el histograma y el panel lo muestra).
const test = require('node:test');
const assert = require('node:assert/strict');
const CLK = require('../public/js/clock');
const FX = require('../public/js/effects');
const P = require('../src/protocol');
const { startServer, login, createSession, joinMaster, joinPublic, dev, sleep } = require('./helpers');

// ------------------------------------------------------------------------------------------------ unidad: estimación del reloj
test('clock.fromWelcome: compensa la demora de bajada con el viaje hello→welcome (antes el error era la demora de bajada completa)', () => {
  // reloj de servidor = reloj del teléfono + 1 000 000 ms; hello sale en perf 0; sube 30 ms, el servidor tarda 2 ms, baja 90 ms
  const DELTA = 1000000, up = 30, proc = 2, down = 90;
  const welcome = { serverTimestamp: DELTA + up + proc, recvAt: up + proc + down, helloAt: 0 };
  const nuevo = CLK.fromWelcome({ ...welcome, prevSynced: false });
  const viejo = welcome.serverTimestamp - welcome.recvAt;                         // fórmula anterior
  assert.equal(nuevo.source, 'hello');
  assert.equal(Math.abs(viejo - DELTA), down, 'antes: error = demora de bajada (90 ms)');
  assert.equal(Math.abs(nuevo.offset - DELTA), Math.abs(up + proc - down) / 2, 'ahora: error = (subida + proceso − bajada)/2 = 29 ms');
  // red simétrica: error ≈ 1 ms (solo el tiempo de proceso del servidor / 2)
  const sim = CLK.fromWelcome({ serverTimestamp: DELTA + 50 + 2, recvAt: 50 + 2 + 50, helloAt: 0, prevSynced: false });
  assert.equal(Math.abs(sim.offset - DELTA), 1);
});

test('clock.fromWelcome: sin hello válido cae a la estimación simple; al reconectar conserva la estimación previa si es coherente y adopta la nueva si el reloj saltó', () => {
  assert.equal(CLK.fromWelcome({ serverTimestamp: 5000, recvAt: 1000, helloAt: null, prevSynced: false }).source, 'welcome');
  assert.equal(CLK.fromWelcome({ serverTimestamp: 5000, recvAt: 1000, helloAt: 900000, prevSynced: false }).source, 'welcome', 'hello en el futuro: se ignora');
  assert.equal(CLK.fromWelcome({ serverTimestamp: 5000, recvAt: 10000, helloAt: 0, prevSynced: false }).source, 'welcome', 'RTT ≥ 5 s: no sirve');
  const prev = 3995;                                                                  // estimación previa, ya refinada por pings
  const keep = CLK.fromWelcome({ serverTimestamp: 5060, recvAt: 1100, helloAt: 1000, prevOffset: prev, prevSynced: true });
  assert.equal(keep.source, 'previa'); assert.equal(keep.offset, prev, 'reconexión: no se pierde una buena estimación');
  const jump = CLK.fromWelcome({ serverTimestamp: 90000, recvAt: 1100, helloAt: 1000, prevOffset: prev, prevSynced: true });
  assert.equal(jump.source, 'hello'); assert.ok(Math.abs(jump.offset - (90000 + 50 - 1100)) < 1, 'el servidor cambió de reloj (>1 s): se adopta la nueva');
  assert.equal(CLK.fromWelcome({ serverTimestamp: 5060, recvAt: 1100, helloAt: 1000, prevOffset: prev, prevSynced: false }).source, 'hello', 'sin sincronía previa no se conserva nada');
});

test('clock.addPong: valida la muestra, se queda con la de menor RTT y limita la ventana a 12', () => {
  const samples = [];
  assert.equal(CLK.addPong(samples, { t0: 100, serverTimestamp: 9e12 }, 50), null, 'RTT negativo');
  assert.equal(CLK.addPong(samples, { t0: 0, serverTimestamp: 9e12 }, 5001), null, 'RTT > 5 s');
  assert.equal(CLK.addPong(samples, { t0: 0, serverTimestamp: 'x' }, 50), null, 'sin marca de servidor');
  assert.equal(samples.length, 0);
  const r1 = CLK.addPong(samples, { t0: 0, serverTimestamp: 1000050 }, 100);      // RTT 100, offset 1000000
  const r2 = CLK.addPong(samples, { t0: 200, serverTimestamp: 1000230 }, 240);     // RTT 40 (mejor), offset = 1000230 + 20 − 240 = 1000010
  const r3 = CLK.addPong(samples, { t0: 300, serverTimestamp: 1000450 }, 500);     // RTT 200
  assert.equal(r1.best.rtt, 100); assert.equal(r2.best.rtt, 40); assert.equal(r3.best.rtt, 40, 'sigue la de menor RTT');
  assert.equal(r3.best.offset, 1000010);
  for (let i = 0; i < 30; i++) CLK.addPong(samples, { t0: 1000 + i, serverTimestamp: 5e6 }, 1100 + i);
  assert.equal(samples.length, CLK.MAX_SAMPLES);
});

// ------------------------------------------------------------------------------------------------ simulación: 60 000 teléfonos
function prng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const lognorm = (r, median, sigma) => { const u = Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()); return median * Math.exp(sigma * u); };
const expo = (r, mean) => -mean * Math.log(1 - r());
const pctl = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

test('simulación de 60 000 teléfonos que escanean a horas distintas con redes móviles asimétricas: el reloj compensado reduce el error de ingreso y el de régimen es solo la asimetría', t => {
  const r = prng(20261011); const N = 60000;
  const viejo = [], nuevo = [], regimen = [], ingresoNuevoMasPings = [];
  for (let i = 0; i < N; i++) {
    // red de este teléfono: bajada ~70 ms (lognormal), subida = bajada × razón ~1,2 (la subida móvil suele ser más lenta), jitter exponencial de 15 ms por mensaje
    const d0 = lognorm(r, 70, 0.55), ratio = lognorm(r, 1.2, 0.4), u0 = d0 * ratio;
    const msg = () => ({ up: u0 + expo(r, 15), down: d0 + expo(r, 15) });
    const DELTA = 1e12 + Math.floor(r() * 1e9), proc = 2;
    // welcome (viaje hello→welcome)
    const h = msg(); const welcome = { serverTimestamp: DELTA + h.up + proc, recvAt: h.up + proc + h.down, helloAt: 0 };
    const o = CLK.fromWelcome({ ...welcome, prevSynced: false });
    nuevo.push(Math.abs(o.offset - DELTA)); viejo.push(Math.abs((welcome.serverTimestamp - welcome.recvAt) - DELTA));
    // 6 pings de la ráfaga inicial; se queda con la muestra de menor RTT
    const samples = []; let best = null;
    for (let k = 0; k < 6; k++) { const m = msg(); const s0 = 1000 + k * 120; const res = CLK.addPong(samples, { t0: s0, serverTimestamp: DELTA + s0 + m.up }, s0 + m.up + m.down); best = res.best; }
    regimen.push(Math.abs(best.offset - DELTA));
  }
  const st = a => ({ p50: Math.round(pctl(a, 0.5)), p95: Math.round(pctl(a, 0.95)), p99: Math.round(pctl(a, 0.99)) });
  const out = { telefonos: N, errorIngresoAnteriorMs: st(viejo), errorIngresoCompensadoMs: st(nuevo), errorEnRegimenMs: st(regimen) };
  t.diagnostic(JSON.stringify(out));
  assert.ok(pctl(nuevo, 0.95) < pctl(viejo, 0.95) / 2, `el error de ingreso p95 baja a menos de la mitad: ${JSON.stringify(out)}`);
  assert.ok(pctl(nuevo, 0.5) < pctl(viejo, 0.5) / 2);
  assert.ok(pctl(regimen, 0.5) < 40 && pctl(regimen, 0.95) < 110, 'en régimen el error es la asimetría residual (cota RTT/2): ' + JSON.stringify(out.errorEnRegimenMs));
});

// ------------------------------------------------------------------------------------------------ unidad: planificación exacta del dibujo
const seqState = extra => ({ executeAt: 10000, payload: { effect: 'sequence', color: '#FF0000', steps: [{ color: '#FF0000', holdMs: 3000 }, { color: '#00FF00', holdMs: 3000 }], fadeMs: 0, durationMs: 0, ...extra } });
test('effects.evaluate: la secuencia informa en `next` los ms hasta el próximo cambio posible (permite dormir entre cambios y despertar justo antes)', () => {
  const s = seqState();
  assert.equal(FX.evaluate(s, 10000 + 100).next, 2900); assert.equal(FX.evaluate(s, 10000 + 2999).next, 1);
  assert.equal(FX.evaluate(s, 10000 + 3000).next, 3000, 'justo en la frontera: el paso nuevo recién empieza'); assert.equal(FX.evaluate(s, 10000 + 6100).next, 2900, 'segunda vuelta');
  const f = seqState({ fadeMs: 500 });
  assert.equal(FX.evaluate(f, 10000 + 3200).next, 0, 'durante el fundido hay que dibujar en cada cuadro'); assert.equal(FX.evaluate(f, 10000 + 3600).next, 2400);
  assert.equal(FX.evaluate(seqState({ durationMs: 4000 }), 10000 + 9000).next, undefined, 'terminada: sin próximo cambio');
  assert.equal(FX.evaluate(s, 10000 + 100, { manualOff: true }).next, undefined, 'fija: no hay cambios');
  for (const effect of ['solid', 'fade', 'pulse', 'strobe']) assert.equal(FX.evaluate({ executeAt: 0, payload: { effect, color: '#FF0000', color2: '#000000', fadeMs: 500, periodMs: 2000, hz: 2, duty: 0.25, durationMs: 5000 } }, 100).next, undefined, effect + ': sin pista (se dibuja a ritmo fijo)');
  // en cada instante dado, el `next` es exactamente el tiempo que falta hasta que el color cambie
  for (let t = 0; t < 12000; t += 137) { const r0 = FX.evaluate(s, 10000 + t); const c0 = r0.rgb.join(); assert.equal(FX.evaluate(s, 10000 + t + r0.next - 1).rgb.join(), c0, 't=' + t); assert.notEqual(FX.evaluate(s, 10000 + t + r0.next).rgb.join(), c0, 't=' + t); }
});

// ------------------------------------------------------------------------------------------------ protocolo / servidor
test('protocolo: el ping acepta `rtt` opcional numérico y rechaza valores inválidos o campos desconocidos', () => {
  assert.deepEqual(P.validatePing({ type: 'ping', t0: 5 }), { t0: 5, rtt: null });
  assert.deepEqual(P.validatePing({ type: 'ping', t0: 5, rtt: 87 }), { t0: 5, rtt: 87 });
  for (const bad of [-1, 'x', null, 60001, NaN]) assert.throws(() => P.validatePing({ type: 'ping', t0: 5, rtt: bad }), e => ['INVALID_FIELD', 'OUT_OF_RANGE'].includes(e.code), String(bad));
  assert.throws(() => P.validatePing({ type: 'ping', t0: 5, otro: 1 }), e => e.code === 'UNKNOWN_FIELD');
  assert.equal(typeof P.server.pong(5, 123).serverTimestamp, 'number'); assert.equal(P.server.pong(5, 123).serverTimestamp, 123);
});

test('integración: los ping con `rtt` alimentan el histograma de calidad de reloj y el panel recibe p50/p95 en la salud', async t => {
  const srv = await startServer({ presenceIntervalMs: 200 }); t.after(srv.stop);
  const op = await login(srv.base); const s = await createSession(srv.base, op);
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phones = await Promise.all([1, 2, 3].map(n => joinPublic(srv.wsUrl, s.sessionId, dev(n))));
  const rtts = [30, 80, 400];
  phones.forEach((p, i) => p.send({ protocolVersion: 1, type: 'ping', t0: 1000 + i, rtt: rtts[i] }));
  for (const p of phones) { const pong = await p.waitFor('pong'); assert.ok(Math.abs(pong.serverTimestamp - Date.now()) < 50, 'la marca del pong es la hora del servidor'); }
  phones[0].send({ protocolVersion: 1, type: 'ping', t0: 5 });                       // un ping SIN rtt sigue siendo válido (clientes anteriores)
  await phones[0].waitFor('pong');
  assert.equal(srv.app.metrics.hists.clockRttMs.n, 3);
  const h = srv.app.getHealth(); assert.equal(h.clockRtt.n, 3); assert.ok(h.clockRtt.p50 >= 30 && h.clockRtt.p95 >= 300);
  const pres = await master.waitFor(m => m.type === 'presence' && m.health && m.health.clockRtt && m.health.clockRtt.n === 3, 3000);
  assert.ok(pres.health.clockRtt.p95 >= 300);
  const st = await (await fetch(srv.base + '/api/admin/status', { headers: { authorization: 'Bearer ' + op } })).json();
  assert.equal(st.clock.source, 'store'); assert.equal(st.clock.offsetMs, 0, 'una sola instancia en memoria: reloj local'); assert.equal(st.metrics.latency.clockRttMs.n, 3);
});
