'use strict';
// Servicio de sesiones: creación, listado y emisión de tokens de Master con alcance a una sesión.
const crypto = require('crypto');
const { SESSION_RE } = require('./protocol');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}

class SessionError extends Error {
  constructor(code, status, message) { super(message || code); this.code = code; this.status = status; }
}

function createSessionService({ config, store, auth }) {
  function joinUrl(baseFromRequest, id) {
    const base = config.publicBaseUrl || baseFromRequest;
    // Compatible con los enlaces/QR anteriores: /?s=CODIGO&mode=remote
    return `${base}/?s=${id}&mode=remote`;
  }

  return {
    joinUrl,
    async create(baseUrl, requestedId) {
      if ((await store.countSessions()) >= config.maxSessions) throw new SessionError('TOO_MANY_SESSIONS', 429, 'Se alcanzó el máximo de sesiones activas');
      if (requestedId) {
        // Re-crear una sesión con el mismo código (p. ej. tras un reinicio sin almacenamiento compartido) para que los teléfonos ya conectados la retomen.
        if (!SESSION_RE.test(requestedId)) throw new SessionError('INVALID_SESSION', 400, 'Código de sesión inválido');
        const rec = await store.createSession(requestedId);
        if (!rec) throw new SessionError('SESSION_EXISTS', 409, 'La sesión ya existe');
        const t = auth.issueMasterToken(rec.id, rec.epoch);
        return { sessionId: rec.id, joinUrl: joinUrl(baseUrl, rec.id), masterToken: t.token, masterTokenExpiresAt: t.expiresAt, state: rec.state, strobeEnabled: rec.strobeEnabled };
      }
      for (let i = 0; i < 20; i++) {
        const rec = await store.createSession(genCode());
        if (rec) {
          const t = auth.issueMasterToken(rec.id, rec.epoch);
          return { sessionId: rec.id, joinUrl: joinUrl(baseUrl, rec.id), masterToken: t.token, masterTokenExpiresAt: t.expiresAt, state: rec.state, strobeEnabled: rec.strobeEnabled };
        }
      }
      throw new SessionError('CODE_COLLISION', 503, 'No se pudo generar un código de sesión');
    },
    async mintMasterToken(id, baseUrl) {
      const rec = await store.getSession(id);
      if (!rec) throw new SessionError('SESSION_NOT_FOUND', 404, 'Sesión inexistente o vencida');
      const t = auth.issueMasterToken(rec.id, rec.epoch);
      return { sessionId: rec.id, joinUrl: joinUrl(baseUrl, rec.id), masterToken: t.token, masterTokenExpiresAt: t.expiresAt, state: rec.state, strobeEnabled: rec.strobeEnabled };
    },
    // Revoca todos los tokens de Master emitidos hasta ahora para la sesión (rotación del epoch).
    async revokeMasterTokens(id) {
      const epoch = await store.rotateEpoch(id);
      if (!epoch) throw new SessionError('SESSION_NOT_FOUND', 404, 'Sesión inexistente o vencida');
      return { epoch };
    },
    list: limit => store.listSessions(limit),
    get: id => store.getSession(id),
    async close(id) { await store.deleteSession(id); }
  };
}

module.exports = { createSessionService, SessionError, genCode };
