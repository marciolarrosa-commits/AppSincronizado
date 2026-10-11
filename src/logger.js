'use strict';
// Logs estructurados (una línea JSON por evento). Nunca se registran tokens ni contraseñas:
// cualquier campo con nombre sospechoso se redacta antes de escribir.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /token|password|secret|authorization|cookie|key/i;

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 300) return value.slice(0, 300) + '…';
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

module.exports = { createLogger, redact };
