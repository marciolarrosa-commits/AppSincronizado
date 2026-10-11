'use strict';
// Autenticación del operador (Master) y tokens firmados con HMAC-SHA256.
//  - Operador: inicia sesión con MASTER_PASSWORD -> token de operador (REST).
//  - Master de sesión: token con alcance a UNA sesión (WebSocket). Lleva el "epoch" de la sesión: rotarlo invalida los anteriores.
// Los tokens nunca viajan en la URL ni se escriben en logs.
const crypto = require('crypto');

const b64 = buf => Buffer.from(buf).toString('base64url');

function createAuth(config) {
  const secret = typeof config.tokenSecret === 'string' ? Buffer.from(config.tokenSecret) : config.tokenSecret;

  function sign(payload) {
    const body = b64(JSON.stringify(payload));
    const mac = crypto.createHmac('sha256', secret).update(body).digest();
    return `${body}.${b64(mac)}`;
  }

  function verify(token, { role, sessionId } = {}) {
    if (typeof token !== 'string' || token.length > 600) return null;
    const dot = token.indexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let p;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!p || typeof p.exp !== 'number' || p.exp * 1000 < Date.now()) return null;
    if (role && p.r !== role) return null;
    if (sessionId && p.sid !== sessionId) return null;
    return p;
  }

  function checkPassword(candidate) {
    if (typeof candidate !== 'string' || candidate.length > 256) return false;
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(config.masterPassword).digest();
    return crypto.timingSafeEqual(a, b);
  }

  return {
    checkPassword,
    issueOperatorToken() {
      const exp = Math.floor(Date.now() / 1000) + config.operatorTokenTtlS;
      return { token: sign({ r: 'op', exp, jti: crypto.randomBytes(6).toString('hex') }), expiresAt: exp * 1000 };
    },
    verifyOperator: token => verify(token, { role: 'op' }),
    issueMasterToken(sessionId, epoch) {
      const exp = Math.floor(Date.now() / 1000) + config.masterTokenTtlS;
      return { token: sign({ r: 'ma', sid: sessionId, ep: epoch, exp, jti: crypto.randomBytes(6).toString('hex') }), expiresAt: exp * 1000 };
    },
    verifyMaster: (token, sessionId) => verify(token, { role: 'ma', sessionId }),
    bearer(req) {
      const h = req.headers.authorization || '';
      return /^Bearer\s+(\S{1,600})$/i.test(h) ? h.replace(/^Bearer\s+/i, '') : null;
    }
  };
}

module.exports = { createAuth };
