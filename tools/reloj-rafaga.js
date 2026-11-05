'use strict';
// Simulación reproducible de la ráfaga inicial de pings de reloj (V4.0): compara la estrategia anterior (6 pings cada 120 ms) con alternativas repartidas,
// con 60 000 teléfonos que se unen a la vez (el peor caso: reconexión masiva). Mide (1) la carga PICO de pings por segundo que recibiría el servidor y
// (2) el error del reloj estimado con la muestra de menor RTT (el mismo criterio que public/js/clock.js).
//
// ES UN MODELO, no una medición de campo: la red móvil real puede ser peor (asimetría y jitter distintos). Sirve para comparar estrategias entre sí, no para
// prometer un error absoluto en el estadio. Uso: node tools/reloj-rafaga.js [teléfonos=60000] [semilla=1]
const N = Number(process.argv[2]) || 60000;
let seed = Number(process.argv[3]) || 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };           // LCG determinista: mismos números en cada corrida
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
const lognorm = (median, sigma) => median * Math.exp(sigma * gauss());
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// Estrategias: instante (ms desde el welcome) de cada ping. `jit` = instante aleatorio dentro de su franja.
const STRATEGIES = {
  'V3.x: 6 pings cada 120 ms': () => [0, 120, 240, 360, 480, 600],
  '6 pings repartidos en 3 s': () => Array.from({ length: 6 }, (_, i) => (i + rnd()) * 500),
  'V4.0: 3 pings repartidos en 3 s': () => Array.from({ length: 3 }, (_, i) => (i + rnd()) * 1000),
  '2 pings repartidos en 3 s': () => Array.from({ length: 2 }, (_, i) => (i + rnd()) * 1500),
  '1 ping (referencia: solo hello→welcome + 1)': () => [rnd() * 3000]
};

function run(name, times) {
  const bucket = new Map(); let total = 0; const errs = []; const errsAfterHello = [];
  for (let k = 0; k < N; k++) {
    // Red móvil: retardo base por teléfono (mediana 60 ms ida y 60 ms vuelta), asimetría fija por teléfono, jitter por paquete (lognormal).
    const base = lognorm(60, 0.5), asym = 1 + 0.5 * gauss() * 0.4;                         // subida = base·asym, bajada = base/asym (asimetría típica ±20 %)
    const up = () => base * Math.max(0.4, asym) * lognorm(1, 0.35), down = () => (base / Math.max(0.4, asym)) * lognorm(1, 0.35);
    // Estimación inicial por hello→welcome (V3.4.0): error = (subida − bajada)/2 de ESE intercambio.
    const u0 = up(), d0 = down(); let best = { rtt: u0 + d0, off: (u0 - d0) / 2 };
    // (error de offset = (subida − bajada)/2: positivo si el camino de ida es más lento)
    for (const t of times(k)) {
      const u = up(), d = down();
      const s = { rtt: u + d, off: (u - d) / 2 };
      if (s.rtt < best.rtt) best = s;
      const tb = Math.floor(t / 100); bucket.set(tb, (bucket.get(tb) || 0) + 1); total++;
    }
    errs.push(Math.abs(best.off)); errsAfterHello.push(Math.abs((u0 - d0) / 2));
  }
  const peak100 = Math.max(...bucket.values());
  return { estrategia: name, pingsTotales: total, picoPingsPorSegundo: peak100 * 10, errorRelojMs: { p50: +q(errs, 0.5).toFixed(1), p95: +q(errs, 0.95).toFixed(1), p99: +q(errs, 0.99).toFixed(1) } };
}

const rows = Object.entries(STRATEGIES).map(([n, f]) => { seed = Number(process.argv[3]) || 1; return run(n, f); });
console.log(`Teléfonos: ${N} (se unen a la vez). Modelo de red: retardo mediano 60 ms por sentido, asimetría ±20 %, jitter lognormal σ=0,35.\n`);
console.table(rows.map(r => ({ estrategia: r.estrategia, 'pings totales': r.pingsTotales, 'pico pings/s': r.picoPingsPorSegundo, 'error p50 ms': r.errorRelojMs.p50, 'error p95 ms': r.errorRelojMs.p95, 'error p99 ms': r.errorRelojMs.p99 })));
console.log(JSON.stringify(rows));
