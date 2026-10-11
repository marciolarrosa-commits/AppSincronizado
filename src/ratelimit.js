'use strict';
// Token bucket simple. `take()` devuelve true si hay cupo.
class TokenBucket {
  constructor(ratePerSec, burst, now = Date.now) {
    this.rate = ratePerSec; this.burst = burst; this.tokens = burst; this.now = now; this.last = now();
  }
  take(n = 1) {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

// Ventana deslizante aproximada por clave (IP). Limpia entradas viejas periódicamente.
class KeyedLimiter {
  constructor(maxPerMinute, now = Date.now) { this.max = maxPerMinute; this.now = now; this.map = new Map(); }
  hit(key) {
    const t = this.now();
    let e = this.map.get(key);
    if (!e || t - e.start >= 60000) { e = { start: t, n: 0 }; this.map.set(key, e); }
    e.n++;
    return e.n <= this.max;
  }
  peek(key) {
    const e = this.map.get(key);
    return !e || this.now() - e.start >= 60000 || e.n < this.max;
  }
  sweep() {
    const t = this.now();
    for (const [k, e] of this.map) if (t - e.start >= 120000) this.map.delete(k);
  }
}

module.exports = { TokenBucket, KeyedLimiter };
