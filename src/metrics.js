'use strict';
// Métricas en memoria por instancia (contadores, gauges e histogramas simples) + formato Prometheus.
const { monitorEventLoopDelay } = require('perf_hooks');

class Histogram {
  constructor(edges) { this.edges = edges; this.counts = new Array(edges.length + 1).fill(0); this.sum = 0; this.n = 0; this.max = 0; }
  observe(v) {
    this.n++; this.sum += v; if (v > this.max) this.max = v;
    let i = 0; while (i < this.edges.length && v > this.edges[i]) i++;
    this.counts[i]++;
  }
  quantile(q) {
    if (!this.n) return null;
    const target = Math.ceil(this.n * q); let acc = 0;
    for (let i = 0; i < this.counts.length; i++) {
      acc += this.counts[i];
      if (acc >= target) return i < this.edges.length ? this.edges[i] : this.max;
    }
    return this.max;
  }
  reset() { this.counts.fill(0); this.sum = 0; this.n = 0; this.max = 0; }
}

const MS_EDGES = [1, 2, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000, 2000, 5000];

function createMetrics() {
  const counters = Object.create(null);
  const gauges = Object.create(null);
  const hists = {
    httpMs: new Histogram(MS_EDGES),
    broadcastMs: new Histogram(MS_EDGES),
    publishMs: new Histogram(MS_EDGES),
    storeMs: new Histogram(MS_EDGES)
  };
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let lastCpu = process.cpuUsage(); let lastCpuAt = Date.now(); let cpuPct = 0;

  const api = {
    hists,
    inc(name, by = 1) { counters[name] = (counters[name] || 0) + by; },
    get(name) { return counters[name] || 0; },
    setGauge(name, v) { gauges[name] = v; },
    observe(name, v) { if (hists[name]) hists[name].observe(v); },
    sampleProcess() {
      const now = Date.now(); const cu = process.cpuUsage(lastCpu);
      const wall = (now - lastCpuAt) * 1000;
      if (wall > 0) cpuPct = Math.round(((cu.user + cu.system) / wall) * 1000) / 10;
      lastCpu = process.cpuUsage(); lastCpuAt = now;
      const m = process.memoryUsage();
      gauges.memory_rss_bytes = m.rss; gauges.memory_heap_used_bytes = m.heapUsed;
      gauges.cpu_percent = cpuPct;
      gauges.event_loop_lag_p99_ms = Math.round(loop.percentile(99) / 1e6 * 10) / 10;
      gauges.event_loop_lag_max_ms = Math.round(loop.max / 1e6 * 10) / 10;
      loop.reset();
    },
    snapshot() {
      return {
        counters: { ...counters }, gauges: { ...gauges },
        // `buckets` permite agregar histogramas de VARIAS instancias sumando contadores (los percentiles no se pueden promediar)
        latency: Object.fromEntries(Object.entries(hists).map(([k, h]) => [k, { n: h.n, p50: h.quantile(0.5), p95: h.quantile(0.95), p99: h.quantile(0.99), max: h.max, sum: h.sum, buckets: { edges: h.edges, counts: [...h.counts] } }]))
      };
    },
    prometheus() {
      const lines = [];
      for (const [k, v] of Object.entries(counters)) { lines.push(`# TYPE destello_${k}_total counter`, `destello_${k}_total ${v}`); }
      for (const [k, v] of Object.entries(gauges)) { lines.push(`# TYPE destello_${k} gauge`, `destello_${k} ${v}`); }
      for (const [k, h] of Object.entries(hists)) {
        lines.push(`# TYPE destello_${k} histogram`);
        let acc = 0;
        h.edges.forEach((e, i) => { acc += h.counts[i]; lines.push(`destello_${k}_bucket{le="${e}"} ${acc}`); });
        acc += h.counts[h.edges.length];
        lines.push(`destello_${k}_bucket{le="+Inf"} ${acc}`, `destello_${k}_sum ${h.sum}`, `destello_${k}_count ${h.n}`);
      }
      return lines.join('\n') + '\n';
    },
    stop() { loop.disable(); }
  };
  return api;
}

module.exports = { createMetrics, Histogram, MS_EDGES };
