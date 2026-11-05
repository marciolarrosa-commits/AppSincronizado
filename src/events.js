'use strict';
// Eventos (V4.0): varios espectáculos independientes sobre la misma infraestructura.
//
// Diseño (evoluciona lo existente, no lo reemplaza):
//   · Un evento es un registro del operador (nombre, fecha, estado, configuración) guardado en el almacenamiento compartido, sin vencimiento.
//   · Su código público de 6 caracteres ES el código de la sesión (sala) que lo atiende: el aislamiento entre eventos es el de las sesiones, que ya existía
//     (sala del hub, canal Redis `ch:<código>`, estado, versión, presencia y acks por código). No hay estado global compartido entre eventos.
//   · La sesión existe SOLO mientras el evento está «activo»: fuera de ese estado un teléfono que escanee el QR recibe SESSION_NOT_FOUND (4404) o EVENT_ENDED (4410).
//   · QR del evento: <base>/e/<código>. Los QR anteriores /?s=<código>&mode=remote siguen funcionando.
//   · El archivado es LÓGICO: se conserva el registro, la auditoría y las estadísticas; el código queda reservado (no se reutiliza).
const crypto = require('crypto');
const { genCode } = require('./sessions');

const STATUSES = ['draft', 'scheduled', 'active', 'finished', 'cancelled'];
const STATUS_LABEL = { draft: 'Borrador', scheduled: 'Programado', active: 'Activo', finished: 'Finalizado', cancelled: 'Cancelado' };
// Transiciones permitidas. `finished` es definitivo (para repetirlo se duplica el evento).
const TRANSITIONS = {
  draft: ['scheduled', 'active', 'cancelled'],
  scheduled: ['draft', 'active', 'cancelled'],
  active: ['scheduled', 'finished', 'cancelled'],
  finished: [],
  cancelled: ['draft']
};
const EFFECTS = ['solid', 'fade', 'pulse', 'strobe', 'sequence'];
const DEFAULT_EFFECTS = ['solid', 'fade', 'pulse', 'sequence'];      // sin strobe: la fotosensibilidad exige decisión expresa
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const ID_RE = /^ev_[0-9a-f]{16}$/;
const DEFAULT_COLORS = ['#FFFFFF', '#FFD400', '#FF3B30', '#34C759', '#0A84FF', '#AF52DE'];

class EventError extends Error {
  constructor(code, status, message) { super(message || code); this.code = code; this.status = status; }
}
const bad = (field, msg) => new EventError('INVALID_EVENT', 400, `${field}: ${msg}`);

function cleanText(v, field, max, { required = false } = {}) {
  if (v === undefined || v === null) { if (required) throw bad(field, 'obligatorio'); return ''; }
  if (typeof v !== 'string') throw bad(field, 'debe ser texto');
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (required && !t) throw bad(field, 'obligatorio');
  if (t.length > max) throw bad(field, `máximo ${max} caracteres`);
  return t;
}

/** Valida y normaliza la configuración de un evento. Lo desconocido se rechaza (no se guarda basura del cliente). */
function normalizeConfig(c, { strobeAllowed = false } = {}) {
  if (c === undefined || c === null) c = {};
  if (typeof c !== 'object' || Array.isArray(c)) throw bad('config', 'debe ser un objeto');
  const known = new Set(['colors', 'sequences', 'effectsAllowed', 'leadMs']);
  for (const k of Object.keys(c)) if (!known.has(k)) throw bad('config', `campo desconocido «${k}»`);

  let colors = c.colors === undefined ? DEFAULT_COLORS : c.colors;
  if (!Array.isArray(colors) || colors.length < 1 || colors.length > 12 || !colors.every(x => typeof x === 'string' && HEX_RE.test(x))) throw bad('config.colors', 'de 1 a 12 colores #RRGGBB');
  colors = colors.map(x => x.toUpperCase());

  const sequences = [];
  for (const s of (c.sequences === undefined ? [] : c.sequences)) {
    if (sequences.length >= 10) throw bad('config.sequences', 'máximo 10 secuencias');
    if (!s || typeof s !== 'object') throw bad('config.sequences', 'cada secuencia debe ser un objeto');
    const name = cleanText(s.name, 'config.sequences.name', 40, { required: true });
    if (!Array.isArray(s.steps) || s.steps.length < 2 || s.steps.length > 12) throw bad('config.sequences.steps', 'de 2 a 12 pasos');
    const steps = s.steps.map(st => {
      if (!st || typeof st.color !== 'string' || !HEX_RE.test(st.color) || !Number.isFinite(st.holdMs) || st.holdMs < 500 || st.holdMs > 600000) throw bad('config.sequences.steps', 'cada paso: color #RRGGBB y holdMs 500–600000');
      return { color: st.color.toUpperCase(), holdMs: Math.round(st.holdMs) };
    });
    const fadeMs = s.fadeMs === undefined ? 0 : s.fadeMs; const durationMs = s.durationMs === undefined ? 0 : s.durationMs;
    if (!Number.isFinite(fadeMs) || fadeMs < 0 || fadeMs > 10000) throw bad('config.sequences.fadeMs', '0–10000');
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 600000) throw bad('config.sequences.durationMs', '0–600000');
    sequences.push({ name, steps, fadeMs: Math.round(fadeMs), durationMs: Math.round(durationMs) });
  }

  const effects = c.effectsAllowed === undefined ? DEFAULT_EFFECTS : c.effectsAllowed;
  if (!Array.isArray(effects) || !effects.length || !effects.every(e => EFFECTS.includes(e))) throw bad('config.effectsAllowed', `subconjunto de ${EFFECTS.join(', ')}`);
  if (effects.includes('strobe') && !strobeAllowed) throw bad('config.effectsAllowed', 'el strobe está deshabilitado en este servidor (STROBE_ALLOWED=false)');

  let leadMs = null;
  if (c.leadMs !== undefined && c.leadMs !== null) {
    if (!Number.isFinite(c.leadMs) || c.leadMs < 300 || c.leadMs > 8000) throw bad('config.leadMs', '300–8000');
    leadMs = Math.round(c.leadMs);
  }
  return { colors, sequences, effectsAllowed: [...new Set(effects)], leadMs };
}

function normalizeStartsAt(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!Number.isFinite(v) || v < 0 || v > Date.now() + 5 * 365 * 86400000) throw bad('startsAt', 'fecha inválida (milisegundos desde 1970, hasta 5 años)');
  return Math.round(v);
}

function createEventService({ config, store, logger, metrics, auth, getHealth }) {
  const publicUrl = (base, code) => `${config.publicBaseUrl || base}/e/${code}`;

  const view = (ev, base) => ({ ...ev, statusLabel: STATUS_LABEL[ev.status], url: publicUrl(base, ev.code) });

  async function audit(ev, actor, action, detail) {
    const entry = { at: Date.now(), actor: actor || 'sistema', action, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) };
    try { await store.eventAuditAdd(ev.id, entry); } catch (e) { logger.warn('event_audit_failed', { eventId: ev.id, error: String(e && e.message).slice(0, 120) }); }
    logger.info('event_action', { eventId: ev.id, action, actor: entry.actor });
  }

  async function mustGet(id) {
    if (!ID_RE.test(String(id))) throw new EventError('EVENT_NOT_FOUND', 404, 'Evento inexistente');
    const ev = await store.eventGet(id);
    if (!ev) throw new EventError('EVENT_NOT_FOUND', 404, 'Evento inexistente');
    return ev;
  }
  // Escritura con control de concurrencia: si otro operador cambió el evento entre la lectura y la escritura se informa (409) en vez de pisarlo.
  async function save(ev, patch) {
    const next = { ...ev, ...patch, updatedAt: Date.now() };
    const out = await store.eventUpdate(ev.id, next, ev.rev);
    if (!out) throw new EventError('EVENT_CONFLICT', 409, 'El evento fue modificado por otro operador: recargá y repetí la acción');
    return out;
  }

  // La sesión (sala) de un evento existe solo mientras está activo.
  async function openSession(ev) {
    if (!(await store.sessionExists(ev.code))) await store.createSession(ev.code);
  }
  async function closeSession(ev, reason) {
    await store.deleteSession(ev.code);
    await store.publishClose(ev.code, reason).catch(e => logger.warn('event_close_publish_failed', { eventId: ev.id, error: String(e && e.message).slice(0, 120) }));
  }

  async function uniqueCode() {
    for (let i = 0; i < 30; i++) {
      const code = genCode();
      if (!(await store.sessionExists(code))) return code;        // tampoco se reutiliza el código de una sesión suelta viva
    }
    throw new EventError('CODE_COLLISION', 503, 'No se pudo generar un código de evento');
  }

  async function insert(base, fields, actor, action, detail) {
    const live = (await store.eventList(1000)).filter(e => !e.archived).length;
    if (live >= config.maxEvents) throw new EventError('TOO_MANY_EVENTS', 429, 'Se alcanzó el máximo de eventos no archivados');
    for (let i = 0; i < 10; i++) {
      const now = Date.now();
      const ev = { id: 'ev_' + crypto.randomBytes(8).toString('hex'), code: await uniqueCode(), status: 'draft', archived: false, createdAt: now, updatedAt: now, stats: { peakConnected: 0 }, ...fields };
      if (await store.eventCreate(ev)) { const out = await store.eventGet(ev.id); await audit(out, actor, action, detail); return view(out, base); }
    }
    throw new EventError('CODE_COLLISION', 503, 'No se pudo reservar el código del evento');
  }

  return {
    EventError, STATUSES, STATUS_LABEL, TRANSITIONS,
    publicUrl,

    async create(base, body, actor) {
      const fields = {
        name: cleanText(body.name, 'name', 80, { required: true }), description: cleanText(body.description, 'description', 500),
        startsAt: normalizeStartsAt(body.startsAt), config: normalizeConfig(body.config, config)
      };
      return insert(base, fields, actor, 'create', fields.name);
    },

    async get(base, id) { return view(await mustGet(id), base); },
    async list(base, { includeArchived = false } = {}) {
      return (await store.eventList(1000)).filter(e => includeArchived || !e.archived).map(e => view(e, base));
    },
    async auditLog(id, limit = 100) { await mustGet(id); return store.eventAuditList(id, Math.min(300, limit)); },

    async update(base, id, body, actor) {
      const ev = await mustGet(id);
      if (ev.archived) throw new EventError('EVENT_ARCHIVED', 409, 'El evento está archivado');
      if (ev.status === 'finished') throw new EventError('EVENT_FINISHED', 409, 'Un evento finalizado no se edita: duplicalo');
      const patch = {};
      if (body.name !== undefined) patch.name = cleanText(body.name, 'name', 80, { required: true });
      if (body.description !== undefined) patch.description = cleanText(body.description, 'description', 500);
      if (body.startsAt !== undefined) patch.startsAt = normalizeStartsAt(body.startsAt);
      if (body.config !== undefined) patch.config = normalizeConfig(body.config, config);
      for (const k of Object.keys(body)) if (!['name', 'description', 'startsAt', 'config', 'rev'].includes(k)) throw bad(k, 'campo no editable');
      if (!Object.keys(patch).length) throw bad('body', 'nada para cambiar');
      const out = await save(body.rev !== undefined ? { ...ev, rev: Number(body.rev) } : ev, patch);
      await audit(out, actor, 'update', Object.keys(patch).join(', '));
      return view(out, base);
    },

    /** Cambio de estado: activar, desactivar (vuelve a «programado»), finalizar o cancelar. Abre o cierra la sesión del evento. */
    async setStatus(base, id, status, actor) {
      if (!STATUSES.includes(status)) throw bad('status', `debe ser uno de ${STATUSES.join(', ')}`);
      const ev = await mustGet(id);
      if (ev.archived) throw new EventError('EVENT_ARCHIVED', 409, 'El evento está archivado');
      if (ev.status === status) return view(ev, base);
      if (!TRANSITIONS[ev.status].includes(status)) throw new EventError('INVALID_TRANSITION', 409, `No se puede pasar de «${STATUS_LABEL[ev.status]}» a «${STATUS_LABEL[status]}»`);
      // Primero se guarda el estado (con control de concurrencia) y luego se abre/cierra la sala: si el guardado falla no queda nada a medias.
      const out = await save(ev, { status });
      if (status === 'active') await openSession(out);
      else if (ev.status === 'active') await closeSession(out, status === 'scheduled' ? 'DEACTIVATED' : 'ENDED');
      metrics.inc('event_status_' + status);
      await audit(out, actor, 'status', `${ev.status} → ${status}`);
      return view(out, base);
    },

    async duplicate(base, id, actor) {
      const src = await mustGet(id);
      const out = await insert(base, { name: cleanText(`${src.name} (copia)`.slice(0, 80), 'name', 80, { required: true }), description: src.description, startsAt: null, config: src.config }, actor, 'duplicate', `desde ${src.id}`);
      return out;
    },

    /** «Eliminar» = archivado lógico. Exige que el evento NO esté activo y que se confirme escribiendo el código (protección contra accidentes). */
    async archive(base, id, confirm, actor) {
      const ev = await mustGet(id);
      if (ev.archived) return view(ev, base);
      if (ev.status === 'active') throw new EventError('EVENT_ACTIVE', 409, 'Primero desactivá o finalizá el evento');
      if (confirm !== ev.code) throw new EventError('CONFIRMATION_REQUIRED', 400, 'Para archivar hay que confirmar con el código del evento');
      const out = await save(ev, { archived: true, archivedAt: Date.now() });
      await store.deleteSession(out.code).catch(() => {});
      await audit(out, actor, 'archive');
      return view(out, base);
    },
    async restore(base, id, actor) {
      const ev = await mustGet(id);
      if (!ev.archived) return view(ev, base);
      const out = await save(ev, { archived: false, archivedAt: null });
      await audit(out, actor, 'restore');
      return view(out, base);
    },

    /** Token de Master para operar ESE evento (solo si está activo; garantiza que la sala exista). */
    async mintMasterToken(base, id, actor) {
      const ev = await mustGet(id);
      if (ev.archived || ev.status !== 'active') throw new EventError('EVENT_NOT_ACTIVE', 409, 'El evento no está activo: activalo para operarlo');
      await openSession(ev);
      const sess = await store.getSession(ev.code);
      if (!sess) throw new EventError('SESSION_NOT_FOUND', 503, 'No se pudo abrir la sesión del evento');
      const t = auth.issueMasterToken(sess.id, sess.epoch);
      await audit(ev, actor, 'operate');
      return { eventId: ev.id, sessionId: sess.id, joinUrl: publicUrl(base, ev.code), masterToken: t.token, masterTokenExpiresAt: t.expiresAt, state: sess.state, strobeEnabled: sess.strobeEnabled, event: view(ev, base) };
    },

    /** Política que el hub aplica a las órdenes de un Master: null = sesión suelta (sin evento); si hay evento, qué efectos permite y si sigue activo. */
    async policyFor(sessionId) {
      const ev = await store.eventGetByCode(sessionId);
      if (!ev) return null;
      return { eventId: ev.id, active: ev.status === 'active' && !ev.archived, effectsAllowed: ev.config.effectsAllowed, leadMs: ev.config.leadMs };
    },

    async stats(id) {
      const ev = await mustGet(id);
      const sess = ev.status === 'active' ? await store.getSession(ev.code) : null;
      const connected = sess ? await store.presenceTotal(ev.code) : 0;
      const last = sess ? sess.state : null;
      const ack = last && last.stateVersion > 0 ? await store.ackSummary(ev.code, last.stateVersion).catch(() => ({ responded: 0 })) : { responded: 0 };
      if (connected > (ev.stats.peakConnected || 0)) {                       // pico de participantes: se guarda al consultarlo (mejor esfuerzo; si hay conflicto se omite)
        await store.eventUpdate(ev.id, { ...ev, stats: { ...ev.stats, peakConnected: connected }, updatedAt: Date.now() }, ev.rev).catch(() => {});
      }
      return {
        eventId: ev.id, status: ev.status, connected, peakConnected: Math.max(connected, ev.stats.peakConnected || 0), strobeEnabled: sess ? sess.strobeEnabled : false,
        lastOrder: last && last.stateVersion > 0 ? { stateVersion: last.stateVersion, effect: last.payload.effect, color: last.payload.color || null, serverTimestamp: last.serverTimestamp, executeAt: last.executeAt } : null,
        delivery: ack
      };
    },

    /** Panel general: totales, estado de la infraestructura y alertas. */
    async dashboard(base) {
      const all = await store.eventList(1000);
      const live = all.filter(e => !e.archived);
      const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0])); for (const e of live) byStatus[e.status]++;
      const active = live.filter(e => e.status === 'active');
      const perEvent = [];
      for (const e of active) perEvent.push({ id: e.id, name: e.name, code: e.code, connected: await store.presenceTotal(e.code).catch(() => null) });
      const health = getHealth();
      const instances = await store.instanceList().catch(() => []);
      const alerts = [];
      if (health.status !== 'ok') alerts.push({ level: health.status === 'degraded' ? 'warn' : 'bad', text: `Sistema ${health.status}: ${(health.reasons || []).join('; ')}` });
      const storeInfo = await store.health().catch(() => ({ ok: false }));
      if (!storeInfo.ok) alerts.push({ level: 'bad', text: 'El almacenamiento compartido no responde' });
      const problems = [];
      for (const p of perEvent) if (p.connected === 0 && active.find(e => e.id === p.id).updatedAt < Date.now() - 600000) { problems.push(p.id); alerts.push({ level: 'warn', text: `«${p.name}» está activo y no tiene participantes conectados`, eventId: p.id }); }
      for (const e of live) if (e.status === 'scheduled' && e.startsAt && e.startsAt < Date.now()) { problems.push(e.id); alerts.push({ level: 'warn', text: `«${e.name}» debía comenzar y sigue sin activarse`, eventId: e.id }); }
      if (health.status !== 'ok') for (const p of perEvent) problems.push(p.id);
      return {
        events: { total: live.length, archived: all.length - live.length, byStatus, active: active.length },
        connectedTotal: perEvent.reduce((n, p) => n + (p.connected || 0), 0), perEvent,
        infrastructure: { health, store: { ok: storeInfo.ok, kind: store.kind, latencyMs: storeInfo.latencyMs }, instances: instances.length, instanceList: instances },
        alerts, problemEvents: [...new Set(problems)], serverTimestamp: Date.now(), base
      };
    }
  };
}

module.exports = { createEventService, EventError, normalizeConfig, STATUSES, TRANSITIONS, DEFAULT_COLORS, EFFECTS, DEFAULT_EFFECTS, ID_RE };
