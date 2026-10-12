'use strict';
// Logs estructurados (una línea JSON por evento). Nunca se registran tokens ni contraseñas:
// cualquier campo con nombre sospechoso se redacta antes de escribir.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /token|password|secret|authorization|cookie|key/i;

// Además de redactar por NOMBRE de campo, se depuran los VALORES de texto: un mensaje de error o un dato no confiable puede traer un token, un encabezado
// Authorization o una URL con usuario:contraseña dentro de una cadena cualquiera. También se neutralizan los caracteres de control (saltos de línea, etc.):
// JSON.stringify ya los escapa, pero así tampoco sirven para falsificar líneas si el destino de los logs no es JSON.
const TOKEN_LIKE = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g;                // forma «cuerpo.firma» de los tokens firmados
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;                    // credenciales incrustadas en una URL (usuario y clave antes de la arroba)
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');       // construida desde texto: incluye los separadores de línea Unicode

function scrubString(s) {
  let out = s.replace(CONTROL, '?').replace(BEARER, '$1 [REDACTED]').replace(URL_CREDS, '$1[REDACTED]@').replace(TOKEN_LIKE, '[REDACTED_TOKEN]');
  if (out.length > 300) out = out.slice(0, 300) + '…';
  return out;
}

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string') return scrubString(value);
  return value;
}

function createLogger({ level = 'info', instanceId = '', sink = null } = {}) {
  const threshold = LEVELS[level] || LEVELS.info;
  const write = sink || (line => process.stdout.write(line + '\n'));
  function log(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;
    const rec = { ts: new Date().toISOString(), level: lvl, msg, instance: instanceId, ...redact(fields || {}) };
    write(JSON.stringify(rec));
  }
  const api = {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child(base) {
      const wrap = lvl => (m, f) => log(lvl, m, { ...base, ...(f || {}) });
      return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error'), child: b => api.child({ ...base, ...b }) };
    }
  };
  return api;
}

module.exports = { createLogger, redact, scrubString };
