'use strict';
// Store en memoria: una sola instancia. Misma interfaz que el store Redis (ver redis.js).
const { initialState, summarizeAcks } = require('./common');

function createMemoryStore(config) {
  const sessions = new Map();     // id -> { id, createdAt, epoch, strobeEnabled, ver, cmds, state, expiresAt }
  const maxHist = config.maxCommandHistory || 500;
  const handlers = new Map();     // id -> Set<fn>
  const presence = new Map();     // id -> Map<instanceId, {count, exp}>
  const acks = new Map();         // `${id}:${ver}` -> {h, exp}
  const settings = new Map();     // ajustes del operador (sin vencimiento mientras viva el proceso)
  const ttl = config.sessionTtlS * 1000;
  let sweeper = null;

  function live(id) {
    const s = sessions.get(id);
    if (!s) return null;
    if (s.expiresAt < Date.now()) { sessions.delete(id); return null; }
    return s;
  }
  const view = s => ({ id: s.id, createdAt: s.createdAt, epoch: s.epoch, strobeEnabled: s.strobeEnabled, state: s.state });

  return {
    kind: 'memory',
    async init() {
      sweeper = setInterval(() => {
        const now = Date.now();
        for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
        for (const [k, a] of acks) if (a.exp < now) acks.delete(k);
      }, 30000);
      sweeper.unref();
    },
    async close() { if (sweeper) clearInterval(sweeper); },
    async health() { return { ok: true, latencyMs: 0, kind: 'memory' }; },
    async getSetting(key) { return settings.has(key) ? settings.get(key) : null; },
    async setSetting(key, value) { settings.set(key, String(value)); },

    async createSession(id) {
      if (live(id)) return null;
      const now = Date.now();
      const s = { id, createdAt: now, epoch: 1, strobeEnabled: false, ver: 0, cmds: new Map(), state: initialState(now), expiresAt: now + ttl };
      sessions.set(id, s);
      return view(s);
    },
    async getSession(id) { const s = live(id); return s ? view(s) : null; },
    async touchSession(id) { const s = live(id); if (s) s.expiresAt = Date.now() + ttl; },
    async countSessions() { let n = 0; for (const id of sessions.keys()) if (live(id)) n++; return n; },
    async listSessions(limit = 100) {
      const out = [];
      for (const id of sessions.keys()) { const s = live(id); if (s) out.push({ id, createdAt: s.createdAt }); if (out.length >= limit) break; }
      return out;
    },
    async commandHistorySize(id) { const s = live(id); return s ? s.cmds.size : 0; },
    async deleteSession(id) { sessions.delete(id); presence.delete(id); },
    async rotateEpoch(id) { const s = live(id); if (!s) return null; s.epoch += 1; return s.epoch; },
    async setStrobe(id, enabled) { const s = live(id); if (!s) return false; s.strobeEnabled = Boolean(enabled); return true; },

    // Asigna versión monotónica, guarda el estado y publica, todo de forma atómica (JS es de un solo hilo).
    async applyState(id, { commandId, executeAt, serverTimestamp, payload }) {
      const s = live(id);
      if (!s) return null;
      // Idempotencia por commandId sobre una ventana acotada de comandos recientes (no solo el último): un reenvío tardío de un
      // comando YA procesado nunca vuelve a aplicarse ni a publicarse, aunque después se hayan aceptado otros más nuevos.
      const seen = commandId ? s.cmds.get(commandId) : null;
      if (seen) return { duplicate: true, state: { commandId, stateVersion: seen.ver, serverTimestamp: seen.ts, executeAt: seen.executeAt, incarnation: s.createdAt } };
      s.ver += 1;
      if (commandId) { s.cmds.set(commandId, { ver: s.ver, executeAt, ts: serverTimestamp }); if (s.cmds.size > maxHist) s.cmds.delete(s.cmds.keys().next().value); }
      s.state = { commandId, stateVersion: s.ver, serverTimestamp, executeAt, incarnation: s.createdAt, payload };
      s.expiresAt = Date.now() + ttl;
      const msg = { k: 'state', s: s.state };
      for (const fn of handlers.get(id) || []) { try { fn(msg); } catch { /* un suscriptor roto no afecta a los demás */ } }
      return { duplicate: false, state: s.state };
    },

    subscribe(id, fn /*, onResync: no aplica en memoria (entrega síncrona) */) {
      let set = handlers.get(id);
      if (!set) { set = new Set(); handlers.set(id, set); }
      set.add(fn);
      const unsubscribe = async () => { set.delete(fn); if (!set.size) handlers.delete(id); };
      unsubscribe.ready = Promise.resolve();
      return unsubscribe;
    },

    async presenceSet(id, instanceId, count) {
      let m = presence.get(id);
      if (!m) { m = new Map(); presence.set(id, m); }
      m.set(instanceId, { count, exp: Date.now() + config.presenceTtlMs });
    },
    async presenceTotal(id) {
      const m = presence.get(id); if (!m) return 0;
      const now = Date.now(); let total = 0;
      for (const [k, v] of m) { if (v.exp < now) m.delete(k); else total += v.count; }
      return total;
    },

    async ackAdd(id, ver, delta) {
      const key = `${id}:${ver}`;
      let a = acks.get(key);
      if (!a) { a = { h: {}, exp: Date.now() + 10 * 60000 }; acks.set(key, a); }
      for (const [k, v] of Object.entries(delta)) a.h[k] = (a.h[k] || 0) + v;
    },
    async ackSummary(id, ver) { const a = acks.get(`${id}:${ver}`); return summarizeAcks(a ? a.h : {}, config.onTimeToleranceMs); }
  };
}

module.exports = { createMemoryStore };
