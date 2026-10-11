'use strict';
// Store Redis/Valkey: estado compartido, publicación por sesión y presencia entre varias instancias.
// Solo usa comandos básicos (HASH, EVAL, PUBLISH/SUBSCRIBE, EXPIRE, ZSET) -> compatible con Redis 5+, Valkey y Render Key Value.
const { initialState, summarizeAcks } = require('./common');

// Versión monotónica + guardado + publicación atómicos, con IDEMPOTENCIA por commandId sobre una ventana acotada:
//   KEYS[1] sesión (hash) · KEYS[2] canal · KEYS[3] hash commandId -> "versión|executeAt|serverTimestamp" · KEYS[4] zset commandId (score = versión)
//   ARGV: 1 plantilla del estado · 2 ttl ms · 3 commandId · 4 máximo de commandIds recordados · 5 executeAt · 6 serverTimestamp
// Un commandId ya procesado devuelve {0, "ver|executeAt|ts"} SIN tocar el estado ni publicar (aunque ya haya otros comandos más nuevos).
// La ventana se recorta dentro del mismo script (memoria acotada); todo ocurre en un único paso atómico del servidor Redis.
const APPLY_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return nil end
local seen = redis.call('HGET', KEYS[3], ARGV[3])
if seen then return {0, seen} end
local v = redis.call('HINCRBY', KEYS[1], 'ver', 1)
local inc = redis.call('HGET', KEYS[1], 'createdAt') or '0'
local st = (string.gsub(ARGV[1], '"__V__"', tostring(v), 1))
st = (string.gsub(st, '"__I__"', inc, 1))
redis.call('HSET', KEYS[1], 'state', st)
redis.call('HSET', KEYS[3], ARGV[3], v .. '|' .. ARGV[5] .. '|' .. ARGV[6])
redis.call('ZADD', KEYS[4], v, ARGV[3])
local n = redis.call('ZCARD', KEYS[4])
local max = tonumber(ARGV[4])
if n > max then
  local old = redis.call('ZRANGE', KEYS[4], 0, n - max - 1)
  for _, id in ipairs(old) do redis.call('HDEL', KEYS[3], id) end
  redis.call('ZREMRANGEBYRANK', KEYS[4], 0, n - max - 1)
end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('PEXPIRE', KEYS[3], ARGV[2])
redis.call('PEXPIRE', KEYS[4], ARGV[2])
redis.call('PUBLISH', KEYS[2], '{"k":"state","s":' .. st .. '}')
return {1, st}
`;

// Creación ATÓMICA de la sesión: nunca queda un registro a medio crear (sin estado ni TTL) que "envenene" el código.
const CREATE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  if redis.call('HEXISTS', KEYS[1], 'state') == 1 then return 0 end
  redis.call('DEL', KEYS[1])
end
redis.call('HSET', KEYS[1], 'id', ARGV[1], 'createdAt', ARGV[2], 'epoch', '1', 'strobe', '0', 'ver', '0', 'state', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('DEL', KEYS[2], KEYS[3])
redis.call('ZADD', KEYS[4], ARGV[2], ARGV[1])
return 1
`;

function createRedisStore(config, logger) {
  const Redis = require('ioredis');
  const p = config.redisPrefix;
  const ttlMs = config.sessionTtlS * 1000;
  const opts = {
    lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: true, connectTimeout: 5000,
    retryStrategy: times => Math.min(2000, 100 * 2 ** Math.min(times, 5)) + Math.floor(Math.random() * 200)
  };
  const cmd = new Redis(config.redisUrl, opts);
  const sub = new Redis(config.redisUrl, opts);
  const handlers = new Map();   // id -> Set<fn>
  let lastError = null;
  let everReady = false;

  cmd.on('error', e => { lastError = e.message; logger.warn('redis_error', { role: 'cmd', error: e.message }); });
  sub.on('error', e => { lastError = e.message; logger.warn('redis_error', { role: 'sub', error: e.message }); });
  // Tras una reconexión del suscriptor se re-suscriben los canales activos y se AVISA al hub (`onResync`): lo publicado mientras estuvo caído
  // se perdió (pub/sub = como máximo una vez) y hay que reconciliar con el estado guardado.
  sub.on('ready', () => {
    if (!everReady) { everReady = true; return; }
    for (const [id, set] of handlers) {
      Promise.resolve(sub.subscribe(kCh(id))).then(() => set.onResync && set.onResync()).catch(e => logger.warn('redis_resubscribe_failed', { error: e.message }));
    }
  });
  sub.on('message', (channel, raw) => {
    const id = channel.slice((p + 'ch:').length);
    const set = handlers.get(id);
    if (!set) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    for (const fn of set) { try { fn(msg); } catch { /* aislado */ } }
  });

  const kS = id => `${p}s:${id}`;
  const kCh = id => `${p}ch:${id}`;
  const kPres = id => `${p}pres:${id}`;
  const kAck = (id, v) => `${p}ack:${id}:${v}`;
  const kCmd = id => `${p}cmd:${id}`;
  const kCmdZ = id => `${p}cmdz:${id}`;
  const maxHist = config.maxCommandHistory || 500;
  const idxKey = `${p}sessions`;

  function view(h) {
    if (!h || !h.id || !h.state || !h.createdAt) return null;       // registro incompleto (creación interrumpida): equivale a "no existe"
    return { id: h.id, createdAt: Number(h.createdAt), epoch: Number(h.epoch), strobeEnabled: h.strobe === '1', state: JSON.parse(h.state) };
  }

  return {
    kind: 'redis',
    // Costura SOLO para pruebas: simula la caída y la recuperación del suscriptor de pub/sub (sin reconexión automática de por medio).
    _test: {
      async dropSubscriber() { sub.disconnect(false); },
      async restoreSubscriber() { await sub.connect(); for (const id of handlers.keys()) await sub.subscribe(kCh(id)); }
    },
    async init() { await cmd.connect(); await sub.connect(); await cmd.ping(); },
    async close() { try { await cmd.quit(); } catch { cmd.disconnect(); } try { await sub.quit(); } catch { sub.disconnect(); } },
    async health() {
      const t = process.hrtime.bigint();
      try { await cmd.ping(); return { ok: true, latencyMs: Number(process.hrtime.bigint() - t) / 1e6, kind: 'redis' }; }
      catch (e) { return { ok: false, latencyMs: null, kind: 'redis', error: e.message || lastError }; }
    },

    // Ajustes del operador compartidos entre instancias (p. ej. acceso a la app Flash). Sin TTL.
    async getSetting(key) { return cmd.get(p + 'set:' + key); },
    async setSetting(key, value) { await cmd.set(p + 'set:' + key, String(value)); },

    async createSession(id) {
      const now = Date.now();
      const st = initialState(now);
      const ok = await cmd.eval(CREATE_LUA, 4, kS(id), kCmd(id), kCmdZ(id), idxKey, id, String(now), JSON.stringify(st), String(ttlMs));
      return ok === 1 ? { id, createdAt: now, epoch: 1, strobeEnabled: false, state: st } : null;
    },
    async getSession(id) { return view(await cmd.hgetall(kS(id))); },
    async touchSession(id) { await cmd.pexpire(kS(id), ttlMs); },
    async countSessions() {
      await cmd.zremrangebyscore(idxKey, '-inf', Date.now() - ttlMs);
      return cmd.zcard(idxKey);
    },
    async listSessions(limit = 100) {
      const ids = await cmd.zrevrange(idxKey, 0, limit - 1, 'WITHSCORES');
      const out = [];
      for (let i = 0; i < ids.length; i += 2) {
        if (await cmd.exists(kS(ids[i]))) out.push({ id: ids[i], createdAt: Number(ids[i + 1]) });
        else await cmd.zrem(idxKey, ids[i]);
      }
      return out;
    },
    async deleteSession(id) { await cmd.multi().del(kS(id)).del(kPres(id)).del(kCmd(id)).del(kCmdZ(id)).zrem(idxKey, id).exec(); },
    async rotateEpoch(id) { if (!(await cmd.exists(kS(id)))) return null; return cmd.hincrby(kS(id), 'epoch', 1); },
    async setStrobe(id, enabled) { if (!(await cmd.exists(kS(id)))) return false; await cmd.hset(kS(id), 'strobe', enabled ? '1' : '0'); return true; },

    async applyState(id, { commandId, executeAt, serverTimestamp, payload }) {
      const tpl = JSON.stringify({ commandId, stateVersion: '__V__', serverTimestamp, executeAt, incarnation: '__I__', payload });
      const res = await cmd.eval(APPLY_LUA, 4, kS(id), kCh(id), kCmd(id), kCmdZ(id), tpl, String(ttlMs), commandId || '', String(maxHist), String(executeAt), String(serverTimestamp));
      if (!res) return null;
      if (res[0] === 0) {                                  // duplicado: se informa la versión ORIGINAL de ese comando
        const [ver, exec, ts] = String(res[1]).split('|').map(Number);
        const sess = await this.getSession(id);
        return { duplicate: true, state: { commandId, stateVersion: ver, serverTimestamp: ts, executeAt: exec, incarnation: sess ? sess.createdAt : 0 } };
      }
      return { duplicate: false, state: JSON.parse(res[1]) };
    },

    async commandHistorySize(id) { return cmd.zcard(kCmdZ(id)); },

    subscribe(id, fn, onResync) {
      let set = handlers.get(id);
      if (!set) {
        set = new Set(); handlers.set(id, set);
        // `ready` resuelve cuando Redis confirma la suscripción: el hub la espera antes de leer el estado (así no se pierde ninguna orden).
        set.ready = sub.subscribe(kCh(id));
      }
      set.add(fn); if (onResync) set.onResync = onResync;
      const unsubscribe = async () => {
        set.delete(fn);
        if (!set.size) { handlers.delete(id); try { await sub.unsubscribe(kCh(id)); } catch { /* cerrando */ } }
      };
      unsubscribe.ready = set.ready;
      return unsubscribe;
    },

    async presenceSet(id, instanceId, count) {
      await cmd.multi().hset(kPres(id), instanceId, `${count}:${Date.now() + config.presenceTtlMs}`).pexpire(kPres(id), config.presenceTtlMs * 6).exec();
    },
    async presenceTotal(id) {
      const h = await cmd.hgetall(kPres(id)); const now = Date.now(); let total = 0; const stale = [];
      for (const [inst, v] of Object.entries(h)) {
        const [c, exp] = v.split(':');
        if (Number(exp) < now) stale.push(inst); else total += Number(c);
      }
      if (stale.length) cmd.hdel(kPres(id), ...stale).catch(() => {});
      return total;
    },

    async ackAdd(id, ver, delta) {
      const pipe = cmd.multi();
      for (const [k, v] of Object.entries(delta)) pipe.hincrby(kAck(id, ver), k, v);
      pipe.pexpire(kAck(id, ver), 10 * 60000);
      await pipe.exec();
    },
    async ackSummary(id, ver) { return summarizeAcks(await cmd.hgetall(kAck(id, ver)), config.onTimeToleranceMs); }
  };
}

module.exports = { createRedisStore };
