'use strict';
// Limitadores de frecuencia.
//  - TokenBucket: cupo por conexión (mensajes WebSocket). Local por naturaleza (la conexión vive en un proceso).
//  - KeyedLimiter: ventana fija por clave (IP) EN MEMORIA DEL PROCESO. Con varias instancias cada una cuenta por separado (el límite efectivo se multiplica).
//  - SharedLimiter: la misma ventana, pero el contador vive en el almacenamiento compartido (Redis/Valkey) con una operación atómica: el límite vale para
//    TODO el servicio, sin importar cuántas instancias o workers haya. Si el almacenamiento no responde se usa el contador local (nunca se apaga el límite
//    ni se cae el servicio) y queda registrado.

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

/**
 * Límite compartido por clave. API asíncrona:
 *   hit(key)  -> true si la petición está dentro del límite (cuenta un golpe)
 *   peek(key) -> true si la clave todavía NO alcanzó el límite (no cuenta)
 * `store` debe ofrecer rateHit(clave, ventanaMs) y rateCount(clave) atómicos (ver src/store/*.js). Con `store` ausente funciona solo en memoria local.
 * Ante un error o demora del almacenamiento (> timeoutMs) se usa el contador local y se abre un «disyuntor» de `breakerMs` para no acumular
 * peticiones colgadas; mientras tanto el límite sigue vigente PERO por instancia (documentado en docs/SEGURIDAD.md).
 */
class SharedLimiter {
  constructor({ name, max, windowMs = 60000, store = null, metrics = null, logger = null, timeoutMs = 150, breakerMs = 5000, now = Date.now }) {
    this.name = name; this.max = max; this.windowMs = windowMs; this.store = store; this.metrics = metrics; this.logger = logger;
    this.timeoutMs = timeoutMs; this.breakerMs = breakerMs; this.now = now;
    this.local = new Map(); this.downUntil = 0; this.lastWarnAt = 0;
  }
  _key(k) { return this.name + ':' + k; }
  _localHit(k) {
    const t = this.now(); let e = this.local.get(k);
    if (!e || t - e.start >= this.windowMs) { e = { start: t, n: 0 }; this.local.set(k, e); }
    return ++e.n;
  }
  _localCount(k) { const e = this.local.get(k); return e && this.now() - e.start < this.windowMs ? e.n : 0; }
  get degraded() { return this.now() < this.downUntil; }
  _fail(err) {
    this.downUntil = this.now() + this.breakerMs;
    if (this.metrics) this.metrics.inc('ratelimit_backend_errors');
    if (this.logger && this.now() - this.lastWarnAt > 30000) {
      this.lastWarnAt = this.now();
      this.logger.warn('ratelimit_backend_degraded', { limiter: this.name, error: String(err && err.message || err).slice(0, 120), fallback: 'local' });
    }
  }
  _withTimeout(p) {
    let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('ratelimit backend timeout')), this.timeoutMs); });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }
  async hit(key) {
    const local = this._localHit(key);                       // siempre se cuenta también en local: es el respaldo exacto si el almacenamiento falla
    if (!this.store || this.degraded) return local <= this.max;
    try { return (await this._withTimeout(Promise.resolve(this.store.rateHit(this._key(key), this.windowMs)))) <= this.max; }
    catch (e) { this._fail(e); return local <= this.max; }
  }
  async peek(key) {
    const local = this._localCount(key);
    if (!this.store || this.degraded) return local < this.max;
    try { return (await this._withTimeout(Promise.resolve(this.store.rateCount(this._key(key))))) < this.max; }
    catch (e) { this._fail(e); return local < this.max; }
  }
  sweep() { const t = this.now(); for (const [k, e] of this.local) if (t - e.start >= this.windowMs * 2) this.local.delete(k); }
}

module.exports = { TokenBucket, KeyedLimiter, SharedLimiter };
