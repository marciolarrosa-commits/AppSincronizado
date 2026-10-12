'use strict';
// Autenticación del operador (Master) y tokens firmados con HMAC-SHA256.
//  - Operador: inicia sesión con MASTER_PASSWORD -> token de operador (REST).
//  - Master de sesión: token con alcance a UNA sesión (WebSocket). Lleva el "epoch" de la sesión: rotarlo invalida los anteriores.
// Los tokens nunca viajan en la URL ni se escriben en logs.
//
// Estrategia de revocación y rotación (resumen; detalle en docs/SEGURIDAD.md):
//   · cerrar sesión          -> revoca ESE token de operador (jti), compartido entre instancias por el almacenamiento (≤ 5 s de retraso en las demás)
//   · cerrar sesión en todos -> sube la «generación» de operador: todo token emitido antes deja de valer
//   · revocar una sesión     -> rota el epoch de la sesión: los tokens de Master anteriores dejan de valer (inmediato)
//   · rotar MASTER_PASSWORD  -> TODOS los tokens (operador y Master) dejan de valer: cada token lleva una huella de la contraseña (`pf`), también con TOKEN_SECRET
//   · rotar TOKEN_SECRET     -> TODOS los tokens dejan de valer (cambia la firma)
const crypto = require('crypto');

const b64 = buf => Buffer.from(buf).toString('base64url');
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LEN = 600;
const MAX_LIFETIME_S = 7 * 24 * 3600;       // ningún token válido dura más (aunque la configuración lo pidiera)
const IAT_SKEW_S = 60;                       // tolerancia de relojes entre instancias al comprobar `iat`
const MIN_SECRET_BYTES = 32;

/**
 * Valida un TOKEN_SECRET configurado explícitamente y devuelve su material como Buffer. Solo se acepta una REPRESENTACIÓN de bytes aleatorios:
 * hexadecimal (≥ 64 caracteres) o base64/base64url (≥ 43 caracteres), que decodifique a ≥ 32 bytes — el formato de `openssl rand` y del `generateValue` de Render.
 * El texto libre NO se acepta: ninguna comprobación separa de forma fiable una frase humana de un valor aleatorio (medido: se solapan), así que se exige un formato
 * que solo sale de un generador. Además se rechazan patrones evidentes (pocos bytes distintos, entropía baja). Son comprobaciones HEURÍSTICAS: no demuestran
 * aleatoriedad; quien configure el valor debe generarlo con un generador criptográfico. Los mensajes de error NUNCA incluyen el valor.
 */
function validateTokenSecret(raw) {
  if (typeof raw !== 'string' || !raw) throw new Error('TOKEN_SECRET vacío.');
  if (raw !== raw.trim()) throw new Error('TOKEN_SECRET tiene espacios al inicio o al final.');
  const hint = 'p. ej. `openssl rand -base64 48` o `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"`';
  let bytes; let minEntropy; let minRepeat; let minRun;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) { bytes = Buffer.from(raw, 'hex'); minEntropy = 3.3; minRepeat = 8; minRun = 7; }                      // hex: como máximo 4 bits por carácter
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) { bytes = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); minEntropy = 4.3; minRepeat = 6; minRun = 5; }
  else throw new Error(`TOKEN_SECRET debe estar en hexadecimal (≥ 64 caracteres) o base64/base64url (≥ 43 caracteres) de ≥ ${MIN_SECRET_BYTES} bytes aleatorios; no se admite texto libre (${hint}).`);
  if (bytes.length < MIN_SECRET_BYTES) throw new Error(`TOKEN_SECRET demasiado corto: se exigen al menos ${MIN_SECRET_BYTES} bytes de material aleatorio (${hint}).`);
  if (new Set(bytes).size < 12) throw new Error('TOKEN_SECRET tiene muy poca variedad: debe ser un valor aleatorio, no un patrón repetitivo.');
  // Entropía de Shannon por carácter: un valor aleatorio en hex/base64 queda por encima del umbral (medido en 20 000 muestras de cada formato); letras en orden, palabras o patrones, por debajo.
  const freq = new Map(); for (const ch of raw) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0; for (const n of freq.values()) { const q = n / raw.length; h -= q * Math.log2(q); }
  if (h < minEntropy || (minEntropy > 4 && freq.size < 22)) throw new Error(`TOKEN_SECRET no parece aleatorio (poca entropía o pocos símbolos distintos): genéralo con ${hint}.`);
  // Patrones que un valor aleatorio casi nunca contiene (probabilidad < 10⁻⁵ por valor): una subcadena larga repetida o una secuencia consecutiva («01234», «efgh…»).
  const seen = new Set(); let repeated = false;
  for (let i = 0; i + minRepeat <= raw.length && !repeated; i++) { const sub = raw.slice(i, i + minRepeat); if (seen.has(sub)) repeated = true; else seen.add(sub); }
  let run = 1; let dir = 0; let sequential = false;
  for (let i = 1; i < raw.length && !sequential; i++) {
    const d = raw.charCodeAt(i) - raw.charCodeAt(i - 1);
    if (d === 1 || d === -1) { run = d === dir ? run + 1 : 2; dir = d; if (run >= minRun) sequential = true; } else { run = 1; dir = 0; }
  }
  if (repeated || sequential) throw new Error(`TOKEN_SECRET contiene patrones repetidos o secuenciales: no parece aleatorio; genéralo con ${hint}.`);
  return bytes;
}

/**
 * Secreto de firma cuando NO se define TOKEN_SECRET: se deriva de MASTER_PASSWORD con scrypt (función lenta y con memoria: cada intento de adivinar la
 * contraseña a partir de un token cuesta ≈ 0,1 s y 32 MB, en vez de microsegundos). Determinista: todas las instancias obtienen el mismo secreto.
 * Sigue siendo MÁS DÉBIL que un TOKEN_SECRET aleatorio: en producción se recomienda definirlo.
 */
function deriveSecretFromPassword(password) {
  return crypto.scryptSync(String(password), 'destello-sync/token-secret/v2', 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

function createAuth(config) {
  const secret = Buffer.isBuffer(config.tokenSecret) ? config.tokenSecret : Buffer.from(String(config.tokenSecret));
  // Huella de la contraseña vigente: se incluye en cada token y se comprueba al verificar. Rotar MASTER_PASSWORD invalida todo token anterior
  // aunque el secreto de firma sea fijo (TOKEN_SECRET). No revela la contraseña (HMAC con el secreto).
  const pwFingerprint = b64(crypto.createHmac('sha256', secret).update('pwfp|' + config.masterPassword).digest()).slice(0, 16);

  const revoked = new Map();          // jti de operador revocado -> vencimiento (s)
  let minGeneration = 0;              // generación mínima válida de los tokens de operador

  function sign(payload) {
    const body = b64(JSON.stringify(payload));
    const mac = crypto.createHmac('sha256', secret).update(body).digest();
    return `${body}.${b64(mac)}`;
  }

  function verify(token, { role, sessionId } = {}) {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LEN) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !B64URL_RE.test(parts[0]) || !B64URL_RE.test(parts[1])) return null;
    const [body, sig] = parts;
    const given = Buffer.from(sig, 'base64url');
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let p;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!p || typeof p !== 'object' || Array.isArray(p) || p.v !== 1) return null;
    if (p.r !== 'op' && p.r !== 'ma') return null;
    if (!Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (p.exp <= now || p.iat > now + IAT_SKEW_S || p.exp <= p.iat || p.exp - p.iat > MAX_LIFETIME_S) return null;
    if (typeof p.jti !== 'string' || !/^[0-9a-f]{12}$/.test(p.jti)) return null;
    if (p.pf !== pwFingerprint) return null;                          // contraseña rotada desde que se emitió
    if (role && p.r !== role) return null;
    if (p.r === 'op') {
      if (!Number.isSafeInteger(p.g) || p.g < minGeneration || revoked.has(p.jti)) return null;
    } else {
      if (typeof p.sid !== 'string' || !Number.isSafeInteger(p.ep)) return null;
      if (sessionId && p.sid !== sessionId) return null;
    }
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
      const iat = Math.floor(Date.now() / 1000); const exp = iat + Math.min(config.operatorTokenTtlS, MAX_LIFETIME_S);
      return { token: sign({ v: 1, r: 'op', iat, exp, jti: crypto.randomBytes(6).toString('hex'), pf: pwFingerprint, g: minGeneration }), expiresAt: exp * 1000 };
    },
    verifyOperator: token => verify(token, { role: 'op' }),
    issueMasterToken(sessionId, epoch) {
      const iat = Math.floor(Date.now() / 1000); const exp = iat + Math.min(config.masterTokenTtlS, MAX_LIFETIME_S);
      return { token: sign({ v: 1, r: 'ma', sid: sessionId, ep: epoch, iat, exp, jti: crypto.randomBytes(6).toString('hex'), pf: pwFingerprint }), expiresAt: exp * 1000 };
    },
    verifyMaster: (token, sessionId) => verify(token, { role: 'ma', sessionId }),
    bearer(req) {
      const h = req.headers.authorization || '';
      return /^Bearer\s+(\S{1,600})$/i.test(h) ? h.replace(/^Bearer\s+/i, '') : null;
    },

    // --- revocación (el estado compartido entre instancias lo sincroniza app.js con el almacenamiento) ---
    /** Revoca un token de operador YA verificado (su payload). Devuelve {jti, exp} para guardarlo en el almacenamiento compartido. */
    revokeOperatorToken(payload) { revoked.set(payload.jti, payload.exp); return { jti: payload.jti, exp: payload.exp }; },
    /** Reemplaza la lista local con la compartida (unión con lo ya conocido) y descarta lo vencido. */
    syncRevoked(list) {
      const now = Math.floor(Date.now() / 1000);
      for (const r of list || []) if (r && typeof r.jti === 'string' && Number.isFinite(r.exp)) revoked.set(r.jti, r.exp);
      for (const [k, v] of revoked) if (v < now) revoked.delete(k);
    },
    setMinGeneration(n) { if (Number.isSafeInteger(n) && n > minGeneration) minGeneration = n; },
    get generation() { return minGeneration; },
    get revokedCount() { return revoked.size; }
  };
}

module.exports = { createAuth, validateTokenSecret, deriveSecretFromPassword, MIN_SECRET_BYTES, MAX_LIFETIME_S };
