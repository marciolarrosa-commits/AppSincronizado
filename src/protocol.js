'use strict';
// Protocolo de mensajes de Destello Sync (versión 1). Documentado en docs/PROTOCOLO.md.
// Todo mensaje entrante se valida acá: tipo, campos permitidos, tipos de dato y rangos. Nada se confía del cliente.
const PROTOCOL_VERSION = 1;

const SESSION_RE = /^[A-HJ-NP-Z2-9]{6}$/;           // alfabeto sin 0/O/1/I/L (QR legible)
const DEVICE_RE = /^[A-Za-z0-9_-]{8,80}$/;
const COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EFFECTS = ['off', 'solid', 'fade', 'pulse', 'strobe'];

const CLIENT_TYPES = new Set(['hello', 'ping', 'applied', 'command', 'stop', 'setConfig']);

class ProtocolError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function onlyKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new ProtocolError('UNKNOWN_FIELD', `Campo no permitido en ${where}: ${k.slice(0, 40)}`);
}

function numberIn(v, min, max, name, { integer = false } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ProtocolError('INVALID_FIELD', `${name} debe ser un número`);
  if (v < min || v > max) throw new ProtocolError('OUT_OF_RANGE', `${name} fuera de rango (${min}..${max})`);
  return integer ? Math.round(v) : v;
}

/** Parsea y valida el envoltorio. Devuelve el objeto (sin validar el payload específico). */
function parseEnvelope(raw, maxBytes) {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (size > maxBytes) throw new ProtocolError('MESSAGE_TOO_LARGE', 'Mensaje demasiado grande');
  let msg;
  try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); }
  catch { throw new ProtocolError('INVALID_JSON', 'JSON inválido'); }
  if (!isPlainObject(msg)) throw new ProtocolError('INVALID_MESSAGE', 'El mensaje debe ser un objeto');
  if (typeof msg.type !== 'string' || !CLIENT_TYPES.has(msg.type)) throw new ProtocolError('UNKNOWN_TYPE', 'Tipo de mensaje desconocido');
  if (msg.protocolVersion !== undefined && msg.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError('UNSUPPORTED_VERSION', `Versión de protocolo no soportada (esperada ${PROTOCOL_VERSION})`);
  }
  return msg;
}

function validateHello(msg) {
  onlyKeys(msg, ['protocolVersion', 'type', 'role', 'sessionId', 'deviceId', 'token', 'resumeVersion', 'reconnect'], 'hello');
  if (msg.role !== 'public' && msg.role !== 'master') throw new ProtocolError('INVALID_ROLE', 'role debe ser public o master');
  if (typeof msg.sessionId !== 'string' || !SESSION_RE.test(msg.sessionId.toUpperCase())) throw new ProtocolError('INVALID_SESSION', 'sessionId inválido');
  const out = { role: msg.role, sessionId: msg.sessionId.toUpperCase(), resumeVersion: 0, reconnect: false };
  if (msg.reconnect !== undefined) { if (typeof msg.reconnect !== 'boolean') throw new ProtocolError('INVALID_FIELD', 'reconnect debe ser booleano'); out.reconnect = msg.reconnect; }
  if (msg.resumeVersion !== undefined) out.resumeVersion = numberIn(msg.resumeVersion, 0, Number.MAX_SAFE_INTEGER, 'resumeVersion', { integer: true });
  if (msg.role === 'master') {
    if (typeof msg.token !== 'string' || msg.token.length < 20 || msg.token.length > 600) throw new ProtocolError('UNAUTHORIZED', 'Token requerido');
    out.token = msg.token;
  } else {
    if (msg.token !== undefined) throw new ProtocolError('INVALID_FIELD', 'Los participantes no envían token');
    if (msg.deviceId !== undefined) {
      if (typeof msg.deviceId !== 'string' || !DEVICE_RE.test(msg.deviceId)) throw new ProtocolError('INVALID_FIELD', 'deviceId inválido');
      out.deviceId = msg.deviceId;
    }
  }
  return out;
}

function validatePing(msg) {
  onlyKeys(msg, ['protocolVersion', 'type', 't0'], 'ping');
  return { t0: numberIn(msg.t0, 0, 1e15, 't0') };
}

const APPLIED_FIELDS = ['protocolVersion', 'type', 'commandId', 'stateVersion', 'deviationMs', 'receiveLeadMs'];
function validateApplied(msg) {
  onlyKeys(msg, APPLIED_FIELDS, 'applied');
  if (typeof msg.commandId !== 'string' || !COMMAND_ID_RE.test(msg.commandId)) throw new ProtocolError('INVALID_FIELD', 'commandId inválido');
  return {
    commandId: msg.commandId,
    stateVersion: numberIn(msg.stateVersion, 0, Number.MAX_SAFE_INTEGER, 'stateVersion', { integer: true }),
    deviationMs: numberIn(msg.deviationMs, -60000, 60000, 'deviationMs'),
    // margen con el que llegó la orden antes de su ejecución (negativo = llegó tarde)
    receiveLeadMs: msg.receiveLeadMs === undefined ? null : numberIn(msg.receiveLeadMs, -60000, 60000, 'receiveLeadMs')
  };
}

const COMMAND_FIELDS = ['protocolVersion', 'type', 'commandId', 'leadMs', 'payload'];
const PAYLOAD_FIELDS = ['effect', 'color', 'color2', 'intensity', 'periodMs', 'hz', 'duty', 'fadeMs', 'durationMs'];

/**
 * Valida una orden visual del Master y devuelve un payload normalizado y completo (con valores por defecto).
 * `limits` viene de la configuración del servidor (frecuencia máxima de strobe, duraciones máximas).
 */
function validateCommand(msg, limits) {
  onlyKeys(msg, COMMAND_FIELDS, 'command');
  const out = { commandId: null, leadMs: null };
  if (msg.commandId !== undefined) {
    if (typeof msg.commandId !== 'string' || !COMMAND_ID_RE.test(msg.commandId)) throw new ProtocolError('INVALID_FIELD', 'commandId inválido');
    out.commandId = msg.commandId;
  }
  if (msg.leadMs !== undefined) out.leadMs = numberIn(msg.leadMs, 0, limits.maxLeadMs, 'leadMs', { integer: true });
  if (!isPlainObject(msg.payload)) throw new ProtocolError('INVALID_FIELD', 'payload requerido');
  const p = msg.payload;
  onlyKeys(p, PAYLOAD_FIELDS, 'payload');
  if (typeof p.effect !== 'string' || !EFFECTS.includes(p.effect)) throw new ProtocolError('INVALID_EFFECT', `effect debe ser uno de: ${EFFECTS.join(', ')}`);
  const payload = { effect: p.effect, color: '#000000', color2: '#000000', intensity: 1 };
  if (p.effect !== 'off') {
    if (typeof p.color !== 'string' || !COLOR_RE.test(p.color)) throw new ProtocolError('INVALID_COLOR', 'color debe tener formato #RRGGBB');
    payload.color = p.color.toUpperCase();
  }
  if (p.color2 !== undefined) {
    if (typeof p.color2 !== 'string' || !COLOR_RE.test(p.color2)) throw new ProtocolError('INVALID_COLOR', 'color2 debe tener formato #RRGGBB');
    payload.color2 = p.color2.toUpperCase();
  }
  if (p.intensity !== undefined) payload.intensity = numberIn(p.intensity, 0.05, 1, 'intensity');
  if (p.effect === 'solid' || p.effect === 'fade') {
    payload.fadeMs = p.fadeMs === undefined ? (p.effect === 'fade' ? 1500 : 0) : numberIn(p.fadeMs, 0, 10000, 'fadeMs', { integer: true });
  }
  if (p.effect === 'pulse') {
    payload.periodMs = p.periodMs === undefined ? 2000 : numberIn(p.periodMs, 600, 10000, 'periodMs', { integer: true });
    payload.durationMs = p.durationMs === undefined ? 0 : numberIn(p.durationMs, 0, limits.maxPulseDurationMs, 'durationMs', { integer: true });
  }
  if (p.effect === 'strobe') {
    payload.hz = p.hz === undefined ? 2 : numberIn(p.hz, 0.5, limits.maxStrobeHz, 'hz');
    payload.duty = p.duty === undefined ? 0.25 : numberIn(p.duty, 0.1, 0.5, 'duty');
    // el strobe SIEMPRE tiene duración máxima: nunca queda activo indefinidamente
    payload.durationMs = p.durationMs === undefined ? Math.min(10000, limits.maxStrobeDurationMs)
      : numberIn(p.durationMs, 500, limits.maxStrobeDurationMs, 'durationMs', { integer: true });
  }
  out.payload = payload;
  return out;
}

function validateStop(msg) {
  onlyKeys(msg, ['protocolVersion', 'type', 'commandId'], 'stop');
  if (msg.commandId !== undefined && (typeof msg.commandId !== 'string' || !COMMAND_ID_RE.test(msg.commandId))) throw new ProtocolError('INVALID_FIELD', 'commandId inválido');
  return { commandId: msg.commandId || null };
}

function validateSetConfig(msg) {
  onlyKeys(msg, ['protocolVersion', 'type', 'strobeEnabled', 'acknowledgeRisk'], 'setConfig');
  if (typeof msg.strobeEnabled !== 'boolean') throw new ProtocolError('INVALID_FIELD', 'strobeEnabled debe ser booleano');
  if (msg.strobeEnabled && msg.acknowledgeRisk !== true) throw new ProtocolError('RISK_NOT_ACKNOWLEDGED', 'Habilitar strobe requiere confirmar la advertencia de fotosensibilidad');
  return { strobeEnabled: msg.strobeEnabled };
}

// --- Constructores de mensajes del servidor (siempre llevan protocolVersion y serverTimestamp) ---
const server = {
  welcome: (o) => ({ protocolVersion: PROTOCOL_VERSION, type: 'welcome', serverTimestamp: Date.now(), ...o }),
  error: (code, message, extra) => ({ protocolVersion: PROTOCOL_VERSION, type: 'error', code, message, serverTimestamp: Date.now(), ...(extra || {}) }),
  pong: (t0) => ({ protocolVersion: PROTOCOL_VERSION, type: 'pong', t0, serverTimestamp: Date.now() }),
  state: (sessionId, state, extra) => ({
    protocolVersion: PROTOCOL_VERSION, type: 'state', sessionId,
    commandId: state.commandId, stateVersion: state.stateVersion, incarnation: state.incarnation, serverTimestamp: state.serverTimestamp,
    executeAt: state.executeAt, payload: state.payload, ...(extra || {})
  })
};

module.exports = {
  PROTOCOL_VERSION, SESSION_RE, DEVICE_RE, COMMAND_ID_RE, COLOR_RE, EFFECTS,
  ProtocolError, parseEnvelope, validateHello, validatePing, validateApplied, validateCommand, validateStop, validateSetConfig, server
};
