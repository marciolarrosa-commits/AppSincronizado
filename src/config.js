'use strict';
// Toda la configuración sale de variables de entorno (ver docs/CONFIGURACION.md). Nada de secretos en el repositorio.
const crypto = require('crypto');
const os = require('os');
const { validateTokenSecret, deriveSecretFromPassword } = require('./auth');

function num(env, name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Variable ${name} inválida: "${raw}"`);
  return Math.min(max, Math.max(min, n));
}

function bool(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  return /^(1|true|yes|si|sí|on)$/i.test(String(raw));
}

function list(env, name) {
  return String(env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
}

function loadConfig(env = process.env, overrides = {}) {
  const production = env.NODE_ENV === 'production';
  const onRender = Boolean(env.RENDER);

  let masterPassword = env.MASTER_PASSWORD || '';
  let masterPasswordGenerated = false;
  if (!masterPassword) {
    if (production) throw new Error('Falta MASTER_PASSWORD (obligatoria con NODE_ENV=production). En Render: servicio > Environment > agregar MASTER_PASSWORD (mínimo 12 caracteres) y volver a desplegar.');
    // Solo desarrollo: contraseña efímera, se imprime una vez al arrancar.
    masterPassword = crypto.randomBytes(9).toString('base64url');
    masterPasswordGenerated = true;
  }
  if (production && masterPassword.length < 12) throw new Error('MASTER_PASSWORD debe tener al menos 12 caracteres en producción.');
  if (production && new Set(masterPassword).size < 6) throw new Error('MASTER_PASSWORD es demasiado simple en producción (muy pocos caracteres distintos): use una contraseña larga y aleatoria.');

  // Secreto de firma de tokens. Con TOKEN_SECRET explícito se EXIGE material aleatorio de ≥ 32 bytes (ver auth.validateTokenSecret; el error no incluye el valor).
  // Sin él se deriva de MASTER_PASSWORD con scrypt (lento): todas las instancias obtienen el mismo secreto sin configuración extra, pero un token filtrado
  // permitiría intentar adivinar una contraseña DÉBIL sin conexión → en producción se recomienda definir TOKEN_SECRET (server.js lo avisa). Los valores de
  // prueba (overrides.tokenSecret) saltan este cálculo: scrypt es costoso y no hace falta repetirlo en cada arranque de prueba.
  let tokenSecret = overrides.tokenSecret; let tokenSecretSource = 'override';
  if (tokenSecret === undefined) {
    if (env.TOKEN_SECRET) { tokenSecret = validateTokenSecret(env.TOKEN_SECRET); tokenSecretSource = 'env'; }
    else { tokenSecret = deriveSecretFromPassword(masterPassword); tokenSecretSource = 'derived'; }
  }

  // URL pública CANÓNICA: se usa para el enlace del QR, la CSP y la validación de Origin; en producción es obligatoria para no depender del encabezado Host
  // (controlado por quien hace la petición). PUBLIC_BASE_URL manda; si falta y estamos en Render, se usa RENDER_EXTERNAL_URL (la define Render).
  const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;
  const explicitBase = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const renderBase = (env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  const publicBaseUrl = explicitBase || (production ? renderBase : '');
  const publicBaseUrlSource = explicitBase ? 'PUBLIC_BASE_URL' : (publicBaseUrl ? 'RENDER_EXTERNAL_URL' : 'none');
  if (publicBaseUrl && !ORIGIN_RE.test(publicBaseUrl)) throw new Error('PUBLIC_BASE_URL inválida: debe ser solo origen, p. ej. https://mi-servicio.onrender.com (sin ruta ni espacios).');
  if (production && publicBaseUrl && !publicBaseUrl.startsWith('https://')) throw new Error('PUBLIC_BASE_URL debe usar https:// en producción (los teléfonos necesitan WSS).');
  if (production && !publicBaseUrl) throw new Error('Falta PUBLIC_BASE_URL (obligatoria con NODE_ENV=production): la URL pública https del servicio, solo el origen (p. ej. https://mi-servicio.onrender.com). En Render se toma RENDER_EXTERNAL_URL si no se define.');
  const allowedOrigins = list(env, 'ALLOWED_ORIGINS');
  for (const o of allowedOrigins) {
    if (o === '*' || o === 'null' || !ORIGIN_RE.test(o)) throw new Error('ALLOWED_ORIGINS contiene un origen no válido (sin comodines ni rutas; formato https://dominio[:puerto]).');
    if (production && !o.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(o)) throw new Error('ALLOWED_ORIGINS debe usar https:// en producción.');
  }

  const trustProxyHops = num(env, 'TRUST_PROXY_HOPS', onRender ? 1 : 0, { min: 0, max: 5 });

  const cfg = {
    production,
    port: num(env, 'PORT', 10000, { min: 0, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    listenBacklog: num(env, 'LISTEN_BACKLOG', 4096, { min: 128 }),   // cola de aceptación: clave ante reconexiones masivas
    publicBaseUrl, publicBaseUrlSource,
    allowedOrigins,
    allowNoOrigin: bool(env, 'ALLOW_NO_ORIGIN', !production),
    // En producción el Origin de un WebSocket solo se acepta si es la URL canónica o está en ALLOWED_ORIGINS; fuera de producción también si coincide con el
    // Host de la petición (comodidad en desarrollo/pruebas: el navegador no permite falsificar Origin, pero Host sí lo controla quien hace la petición).
    originFromHost: !production,
    trustProxyHops,
    // Redirección http -> https según X-Forwarded-Proto (solo con proxy de confianza). Los endpoints de salud quedan exentos (los sondea la plataforma).
    httpsRedirect: bool(env, 'FORCE_HTTPS', production && trustProxyHops > 0),
    instanceId: env.INSTANCE_ID || `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`,
    logLevel: env.LOG_LEVEL || 'info',
    redisUrl: env.REDIS_URL || '',
    redisPrefix: env.REDIS_PREFIX || 'ds:',
    // App «Flash» (micrófono + linterna, versión anterior). Convive con Destello·Sync V3: el operador la habilita desde /master y el valor se guarda
    // en el almacenamiento. Esto es solo el estado INICIAL mientras el operador no lo haya cambiado.
    flashDefaultEnabled: bool(env, 'FLASH_DEFAULT_ENABLED', false),
    // Reloj de las marcas de tiempo (executeAt, pong, welcome): con varias instancias deben ser el MISMO. 'store' (predeterminado) = hora del almacenamiento compartido
    // (Redis TIME); 'local' = reloj del sistema de cada instancia (puede diferir decenas o cientos de ms entre instancias).
    clockSource: env.CLOCK_SOURCE === 'local' ? 'local' : 'store',
    clockSkewMs: 0,                         // solo pruebas: desfasa el reloj local de ESTA instancia para comprobar que la corrección funciona
    // App «Flash» (micrófono + linterna, V1/V2). Convive con Destello·Sync V3: el operador la habilita desde /master (se guarda en el almacenamiento).
    // Este valor es solo el estado INICIAL cuando el operador nunca lo cambió.
    flashDefaultEnabled: bool(env, 'FLASH_DEFAULT_ENABLED', false),

    masterPassword,
    masterPasswordGenerated,
    tokenSecret, tokenSecretSource,
    // Vigencia de los tokens: operador 8 h (un turno de trabajo; hay cierre de sesión con revocación en el servidor) y Master 12 h (igual que la sesión).
    // Tope de 24 h aunque la configuración pida más.
    operatorTokenTtlS: num(env, 'OPERATOR_TOKEN_TTL_S', 8 * 3600, { min: 60, max: 24 * 3600 }),
    masterTokenTtlS: num(env, 'MASTER_TOKEN_TTL_S', 12 * 3600, { min: 60, max: 24 * 3600 }),
    metricsToken: env.METRICS_TOKEN || '',

    sessionTtlS: num(env, 'SESSION_TTL_S', 12 * 3600, { min: 60 }),
    // Idempotencia: cuántos commandId recientes se recuerdan por sesión (memoria acotada). Debe superar con holgura (órdenes/s × ventana de reintento).
    maxCommandHistory: num(env, 'COMMAND_HISTORY', 500, { min: 50, max: 10000 }),
    maxSessions: num(env, 'MAX_SESSIONS', 200, { min: 1 }),
    maxConnections: num(env, 'MAX_CONNECTIONS', 20000, { min: 1 }),
    maxPublicPerSession: num(env, 'MAX_PUBLIC_PER_SESSION', 100000, { min: 1 }),
    maxMastersPerSession: num(env, 'MAX_MASTERS_PER_SESSION', 3, { min: 1 }),

    heartbeatMs: num(env, 'HEARTBEAT_MS', 20000, { min: 1000 }),
    helloTimeoutMs: num(env, 'HELLO_TIMEOUT_MS', 5000, { min: 200 }),
    maxMessageBytes: num(env, 'MAX_MESSAGE_BYTES', 2048, { min: 256, max: 65536 }),
    clockPingIntervalMs: num(env, 'CLOCK_PING_INTERVAL_MS', 30000, { min: 1000 }),   // 1 ping por cliente cada ~30 s (±15 %)

    // Sincronización temporal de las órdenes
    defaultLeadMs: num(env, 'COMMAND_LEAD_MS', 1500, { min: 0, max: 10000 }),
    minLeadMs: num(env, 'COMMAND_MIN_LEAD_MS', 300, { min: 0, max: 10000 }),
    maxLeadMs: num(env, 'COMMAND_MAX_LEAD_MS', 8000, { min: 100, max: 30000 }),
    onTimeToleranceMs: num(env, 'ON_TIME_TOLERANCE_MS', 100, { min: 5 }),
    ackTargetPerCommand: num(env, 'ACK_TARGET_PER_COMMAND', 500, { min: 10 }),

    // Seguridad visual (fotosensibilidad). Valores conservadores por defecto.
    strobeAllowed: bool(env, 'STROBE_ALLOWED', true),
    maxStrobeHz: num(env, 'MAX_STROBE_HZ', 3, { min: 0.5, max: 3 }),
    maxStrobeDurationMs: num(env, 'MAX_STROBE_DURATION_MS', 30000, { min: 1000, max: 120000 }),
    maxPulseDurationMs: num(env, 'MAX_PULSE_DURATION_MS', 600000, { min: 1000 }),

    // Límites de frecuencia
    masterCommandsPerSec: num(env, 'MASTER_COMMANDS_PER_SEC', 5, { min: 1 }),
    masterCommandBurst: num(env, 'MASTER_COMMAND_BURST', 10, { min: 1 }),
    publicMsgPerSec: num(env, 'PUBLIC_MSG_PER_SEC', 5, { min: 1 }),
    publicMsgBurst: num(env, 'PUBLIC_MSG_BURST', 30, { min: 1 }),
    httpPerMin: num(env, 'HTTP_RATE_PER_MIN', 600, { min: 10 }),            // SOLO API/administración por IP (uso humano: muy bajo)
    // Páginas y archivos estáticos: sin límite por IP por defecto (0). Detrás de un NAT de estadio decenas de miles de teléfonos cargan la web
    // casi a la vez desde pocas IP (≈4 archivos por teléfono); limitarlo por IP dejaría a casi todos sin página. La protección volumétrica
    // corresponde a la plataforma (Render/CDN). Se puede activar con HTTP_STATIC_RATE_PER_MIN.
    httpStaticPerMin: num(env, 'HTTP_STATIC_RATE_PER_MIN', 0, { min: 0 }),
    loginPerMin: num(env, 'LOGIN_RATE_PER_MIN', 8, { min: 1 }),
    // Intentos de login FALLIDOS de todas las IP juntas por minuto: por encima se aplica una demora creciente (no un bloqueo: el operador legítimo no queda fuera).
    loginGlobalFailPerMin: num(env, 'LOGIN_GLOBAL_FAIL_PER_MIN', 60, { min: 5 }),
    // Consultas públicas de /api/sessions/:id/status a sesiones inexistentes por IP/min (aparte del límite de uniones fallidas por WebSocket).
    statusMissPerMin: num(env, 'STATUS_MISS_PER_MIN', 30, { min: 1 }),
    // 'store' (predeterminado): los límites de API/login/uniones fallidas se cuentan en el almacenamiento compartido (Redis/Valkey) y valen para TODAS las instancias;
    // sin Redis equivale a memoria local. 'local': siempre por proceso (el límite efectivo se multiplica por el número de instancias).
    rateLimitBackend: env.RATE_LIMIT_BACKEND === 'local' ? 'local' : 'store',
    // Límites POR CAPAS contra abuso sin castigar al público legítimo detrás de NAT (operadoras móviles / Wi-Fi del estadio: miles de teléfonos
    // comparten pocas IP públicas). Ver docs/SEGURIDAD.md ("Límites por IP y NAT"):
    //  1) tope global de la instancia (MAX_CONNECTIONS) -> protege la capacidad, no depende de la IP;
    //  2) conexiones SIN hello simultáneas por IP (PRE_HELLO_MAX_PER_IP): un cliente legítimo completa el hello en milisegundos;
    //  3) fallos por IP (sesión inexistente, token inválido, hello vencido, violaciones de protocolo): señal real de abuso, rara en uso normal;
    //  4) tasa de conexiones por IP muy holgada (WS_CONNECT_PER_MIN_PER_IP): solo frena inundaciones absurdas;
    //  5) conexiones totales por IP (MAX_CONN_PER_IP): desactivado por defecto (0) porque un NAT de estadio puede tener decenas de miles.
    wsConnectPerMinPerIp: num(env, 'WS_CONNECT_PER_MIN_PER_IP', 60000, { min: 1 }),
    preHelloMaxPerIp: num(env, 'PRE_HELLO_MAX_PER_IP', 1000, { min: 1 }),
    maxConnPerIp: num(env, 'MAX_CONN_PER_IP', 0, { min: 0 }),
    badJoinPerMinPerIp: num(env, 'BAD_JOIN_PER_MIN_PER_IP', 120, { min: 1 }),

    // Contrapresión
    bufferSoftBytes: num(env, 'WS_BUFFER_SOFT_BYTES', 64 * 1024, { min: 1024 }),
    bufferHardBytes: num(env, 'WS_BUFFER_HARD_BYTES', 512 * 1024, { min: 4096 }),
    slowStrikes: num(env, 'WS_SLOW_STRIKES', 5, { min: 1 }),
    broadcastChunk: num(env, 'BROADCAST_CHUNK', 500, { min: 50 }),   // envíos por turno del event loop (acota el lag durante una difusión)

    shutdownGraceMs: num(env, 'SHUTDOWN_GRACE_MS', 20000, { min: 0 }),
    shutdownSpreadMs: num(env, 'SHUTDOWN_SPREAD_MS', 8000, { min: 0 }),
    presenceTtlMs: num(env, 'PRESENCE_TTL_MS', 10000, { min: 1000 }),
    // Red de seguridad: el pub/sub de Redis entrega "como máximo una vez". Cada tanto (y al recuperarse el suscriptor) se compara el estado
    // del almacenamiento con lo ya entregado y se reenvía el vigente si faltó alguno.
    reconcileIntervalMs: num(env, 'RECONCILE_INTERVAL_MS', 15000, { min: 200 }),
    presenceIntervalMs: num(env, 'PRESENCE_INTERVAL_MS', 2000, { min: 200 }),

    // Umbrales de salud (ver docs/OBSERVABILIDAD.md)
    degradedLoopLagMs: num(env, 'DEGRADED_LOOP_LAG_MS', 100, { min: 5 }),
    degradedStoreMs: num(env, 'DEGRADED_STORE_MS', 250, { min: 5 })
  };

  return Object.assign(cfg, overrides);
}

module.exports = { loadConfig };
