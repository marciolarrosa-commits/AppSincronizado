'use strict';
// Ensamblado de la aplicación: servidor HTTP (páginas, API REST del operador, salud/métricas) + upgrade WebSocket.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');
const WebSocket = require('ws');

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createMetrics } = require('./metrics');
const { createAuth } = require('./auth');
const { createStore } = require('./store');
const { createSessionService, SessionError } = require('./sessions');
const { createHub } = require('./hub');
const { KeyedLimiter } = require('./ratelimit');
const { SESSION_RE } = require('./protocol');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const VERSION = require('../package.json').version;       // permite verificar qué código está realmente activo (log de arranque y /api/admin/status)
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8'
};

// ---------------------------------------------------------------------------------------------- estáticos
// Los archivos de /public se cargan una vez (con gzip y ETag) y se sirven desde memoria. Para las páginas HTML se calcula
// una CSP por hash de cada <script>/<style> en línea: no hace falta reescribir nada por petición.
function loadStatic() {
  const files = new Map();
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      const ext = path.extname(ent.name).toLowerCase();
      if (!TYPES[ext] || ent.name.endsWith('.artifact.json')) continue;      // *.artifact.json son metadatos del editor, no se publican
      const buf = fs.readFileSync(full);
      const rel = '/' + path.relative(PUBLIC_DIR, full).split(path.sep).join('/');
      const entry = {
        buf, type: TYPES[ext], etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"',
        gz: ['.html', '.js', '.css', '.svg', '.json'].includes(ext) ? zlib.gzipSync(buf, { level: 9 }) : null, csp: null
      };
      if (ext === '.html') entry.csp = cspHashes(buf.toString('utf8'));
      files.set(rel, entry);
    }
  })(PUBLIC_DIR);
  return files;
}

function cspHashes(html) {
  const h = { script: [], style: [] };
  const re = /<(script|style)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].toLowerCase() === 'script' && /\ssrc\s*=/.test(m[2] || '')) continue;
    if (!m[3].trim()) continue;
    h[m[1].toLowerCase()].push(`'sha256-${crypto.createHash('sha256').update(m[3]).digest('base64')}'`);
  }
  return h;
}

function csp(entry, wsOrigins) {
  const s = entry.csp || { script: [], style: [] };
  return [
    "default-src 'none'",
    // blob: lo requiere el AudioWorklet del modo micrófono (se crea a partir de un Blob propio de la página)
    `script-src 'self' blob: ${s.script.join(' ')}`.trim(),
    `style-src 'self' ${s.style.join(' ')}`.trim(),
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:", "manifest-src 'self'",
    `connect-src 'self' ${wsOrigins}`.trim(),
    "media-src 'self'", "worker-src 'self' blob:",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'"
  ].join('; ');
}

// ---------------------------------------------------------------------------------------------- aplicación
function createApp(userConfig = {}, deps = {}) {
  const config = deps.config || loadConfig(process.env, userConfig);
  const logger = deps.logger || createLogger({ level: config.logLevel, instanceId: config.instanceId, sink: deps.logSink });
  const metrics = createMetrics();
  const auth = createAuth(config);
  const store = deps.store || createStore(config, logger);
  const sessions = createSessionService({ config, store, auth });
  const statics = loadStatic();

  const httpLimiter = new KeyedLimiter(config.httpPerMin);
  const staticLimiter = config.httpStaticPerMin > 0 ? new KeyedLimiter(config.httpStaticPerMin) : null;
  const loginLimiter = new KeyedLimiter(config.loginPerMin);
  const wsConnLimiter = new KeyedLimiter(config.wsConnectPerMinPerIp);
  const badJoinLimiter = new KeyedLimiter(config.badJoinPerMinPerIp);
  const sweeper = setInterval(() => { for (const l of [httpLimiter, staticLimiter, loginLimiter, wsConnLimiter, badJoinLimiter]) if (l) l.sweep(); }, 60000);
  sweeper.unref();

  let flashEnabled = Boolean(config.flashDefaultEnabled);     // acceso a la app Flash anterior (/flash); lo cambia el operador desde /master
  let lastStore = { ok: true, latencyMs: 0, kind: store.kind };
  let lastSlowSkips = 0; let slowRecently = false;
  const startedAt = Date.now();
  let shuttingDown = false;

  async function pollStore() {
    try {
      lastStore = await store.health(); metrics.observe('storeMs', lastStore.latencyMs || 0);
      // el interruptor Flash se refresca con este sondeo (cada 5 s): así no hay una consulta al almacenamiento por cada petición de página
      if (lastStore.ok) { const f = await store.getSetting('flashEnabled'); if (f !== null && f !== undefined) flashEnabled = f === '1'; }
    } catch (e) { lastStore = { ok: false, latencyMs: null, kind: store.kind, error: e.message }; }
    metrics.setGauge('store_up', lastStore.ok ? 1 : 0);
    const skips = metrics.get('ws_backpressure_skips'); slowRecently = skips > lastSlowSkips; lastSlowSkips = skips;
  }
  const storeTimer = setInterval(pollStore, 5000); storeTimer.unref();

  // Estado de salud (vivo / listo / capacidad / degradado). Se muestra en el panel Master.
  function getHealth() {
    const reasons = [];
    let status = 'ok';
    const g = metrics.snapshot().gauges;
    if (shuttingDown || (hub && hub.draining)) { status = 'draining'; reasons.push('reiniciando'); }
    if (!lastStore.ok) { status = status === 'draining' ? status : 'degraded'; reasons.push('almacenamiento compartido no responde'); }
    else if (lastStore.latencyMs > config.degradedStoreMs) { if (status === 'ok') status = 'degraded'; reasons.push(`almacenamiento lento (${Math.round(lastStore.latencyMs)} ms)`); }
    if ((g.event_loop_lag_p99_ms || 0) > config.degradedLoopLagMs) { if (status === 'ok') status = 'degraded'; reasons.push(`servidor saturado (lag ${g.event_loop_lag_p99_ms} ms)`); }
    if (slowRecently) { if (status === 'ok') status = 'degraded'; reasons.push('hay clientes lentos que pierden órdenes'); }
    const conns = hub ? hub.connectionCount : 0;
    if (conns >= config.maxConnections) { status = 'overloaded'; reasons.push('capacidad máxima de conexiones'); }
    else if (conns >= config.maxConnections * 0.9) { if (status === 'ok') status = 'degraded'; reasons.push('cerca de la capacidad máxima'); }
    return { status, reasons, eventLoopLagP99Ms: g.event_loop_lag_p99_ms || 0, storeLatencyMs: lastStore.latencyMs, connections: conns, maxConnections: config.maxConnections };
  }

  // Configuración EFECTIVA del almacenamiento, verificable sin exponer secretos (la contraseña de REDIS_URL se enmascara).
  function maskUrl(u) { try { const x = new URL(u); return `${x.protocol}//${x.username || x.password ? '***@' : ''}${x.host}${x.pathname && x.pathname !== '/' ? x.pathname : ''}`; } catch { return '(URL inválida)'; } }
  function storeConfig() { return store.kind === 'redis' ? { kind: 'redis', url: maskUrl(config.redisUrl), prefix: config.redisPrefix, commandHistory: config.maxCommandHistory } : { kind: 'memory', commandHistory: config.maxCommandHistory }; }

  const hub = createHub({ config, store, metrics, logger, auth, getHealth });

  // ------------------------------------------------------------------ utilidades HTTP
  function clientIp(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (config.trustProxyHops > 0 && xff.length) return xff[Math.max(0, xff.length - config.trustProxyHops)];
    return req.socket.remoteAddress || 'unknown';
  }
  // Solo se acepta un Host con forma de nombre/puerto (sin espacios, ';' ni comas): se refleja en la CSP y en el enlace del QR.
  function safeHost(req) {
    const h = String(req.headers.host || '');
    return /^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/.test(h) ? h : 'localhost';
  }
  function baseUrl(req) {
    if (config.publicBaseUrl) return config.publicBaseUrl;
    const fwd = config.trustProxyHops > 0 ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
    const proto = fwd === 'https' ? 'https' : 'http';       // solo http/https: nunca se refleja un valor arbitrario en el enlace del QR
    return `${proto}://${safeHost(req)}`;
  }
  function wsOrigins(req) {
    const host = safeHost(req);
    return config.publicBaseUrl ? config.publicBaseUrl.replace(/^http/, 'ws') : `ws://${host} wss://${host}`;
  }
  function baseHeaders(extra) {
    return {
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin', 'permissions-policy': 'camera=(self), microphone=(self), geolocation=()',
      ...(config.production ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
      ...extra
    };
  }
  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) return { 'access-control-allow-origin': origin, vary: 'Origin' };
    return {};
  }
  function sendJson(req, res, status, obj, extra) {
    const data = JSON.stringify(obj);
    res.writeHead(status, baseHeaders({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(req), ...extra }));
    res.end(data);
  }
  function readJson(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0; let overflow = false; const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (overflow) return;                       // se sigue drenando el cuerpo, pero no se acumula
        if (size > limit) { overflow = true; chunks.length = 0; return reject(Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 })); }
        chunks.push(c);
      });
      req.on('end', () => {
        if (overflow) return;
        if (!size) return resolve({});
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); }
        catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }
  function requireOperator(req) {
    const t = auth.bearer(req);
    const p = t && auth.verifyOperator(t);
    if (!p) throw Object.assign(new Error('No autorizado'), { status: 401, code: 'UNAUTHORIZED' });
    return p;
  }

  // Páginas (sin redirecciones: cada URL responde directamente, no dependen de la caché del navegador):
  //   /                            presentación de Destello·Sync V3 (index.html)
  //   /?s=CODIGO&mode=remote       pantalla del participante (QR de V3, formato conservado) -> flash.html, SIEMPRE disponible
  //   /?mode=remote                app instalada (PWA) sin código -> flash.html, SIEMPRE disponible
  //   /master                      panel del operador (master.html)
  //   /flash  y  /?s=CODIGO        app Flash anterior (micrófono + linterna) -> flash.html, solo si el operador la habilitó
  // flash.html es UN archivo que contiene la app Flash y el cliente remoto de V3 (el ya validado en iPhone): no se separó para no tocarlo.
  function pickPage(pathname, params) {
    const clean = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    if (clean === '/') {
      if (params.get('mode') === 'remote') return { file: '/flash.html' };
      if (params.has('s')) return { file: '/flash.html', flash: true };       // enlaces/QR antiguos de la app Flash: /?s=CODIGO
      return { file: '/index.html' };
    }
    if (clean === '/master') return { file: '/master.html' };
    if (clean === '/flash' || clean === '/flash.html') return { file: '/flash.html', flash: true };
    return { file: clean };
  }

  function serveStatic(req, res, pathname, params) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return sendJson(req, res, 400, { error: 'BAD_REQUEST' }); }
    if (decoded.includes('\0') || decoded.includes('..')) return sendJson(req, res, 400, { error: 'BAD_REQUEST' });
    const page = pickPage(decoded, params);
    let status = 200;
    if (page.flash) {
      if (!flashEnabled) { metrics.inc('flash_page_blocked'); page.file = '/flash-disabled.html'; status = 403; }
      else metrics.inc('flash_page_served');
    }
    decoded = page.file;
    const entry = statics.get(decoded);
    if (!entry || (decoded !== '/' && decoded.startsWith('/.'))) return sendJson(req, res, 404, { error: 'NOT_FOUND' });
    const headers = baseHeaders({ 'content-type': entry.type, etag: entry.etag, 'cache-control': status === 200 ? 'no-cache' : 'no-store', vary: 'Accept-Encoding' });
    if (entry.type.startsWith('text/html')) headers['content-security-policy'] = csp(entry, wsOrigins(req));
    if (status === 200 && req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
    const wantsGzip = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (wantsGzip) headers['content-encoding'] = 'gzip';
    headers['content-length'] = (wantsGzip ? entry.gz : entry.buf).length;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : (wantsGzip ? entry.gz : entry.buf));
  }

  // ------------------------------------------------------------------ rutas
  async function route(req, res, u, ip) {
    const p = u.pathname; const m = req.method;

    if (m === 'OPTIONS') { res.writeHead(204, baseHeaders({ ...corsHeaders(req), 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600' })); return res.end(); }

    if ((m === 'GET' || m === 'HEAD') && p === '/healthz') return sendJson(req, res, 200, { ok: true, status: 'alive', uptimeS: Math.round((Date.now() - startedAt) / 1000) });

    if (m === 'GET' && p === '/readyz') {
      const h = getHealth();
      const ready = !hub.draining && lastStore.ok && h.status !== 'overloaded';
      return sendJson(req, res, ready ? 200 : 503, { ready });
    }

    if (m === 'GET' && p === '/metrics') {
      const t = auth.bearer(req);
      const ok = (config.metricsToken && t && t.length === config.metricsToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(config.metricsToken))) || (t && auth.verifyOperator(t));
      if (!ok) return sendJson(req, res, 401, { error: 'UNAUTHORIZED' });
      res.writeHead(200, baseHeaders({ 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' }));
      return res.end(metrics.prometheus());
    }

    if (m === 'POST' && p === '/api/master/login') {
      if (!loginLimiter.hit(ip)) { metrics.inc('login_rate_limited'); return sendJson(req, res, 429, { error: 'RATE_LIMITED', message: 'Demasiados intentos, esperá un minuto' }, { 'retry-after': '60' }); }
      const body = await readJson(req);
      if (!auth.checkPassword(body.password)) {
        metrics.inc('login_failed'); logger.warn('login_failed', { ip });
        await new Promise(r => setTimeout(r, 250));
        return sendJson(req, res, 401, { error: 'UNAUTHORIZED', message: 'Contraseña incorrecta' });
      }
      metrics.inc('login_ok'); logger.info('login_ok', { ip });
      const t = auth.issueOperatorToken();
      return sendJson(req, res, 200, { operatorToken: t.token, expiresAt: t.expiresAt });
    }

    if (m === 'POST' && p === '/api/sessions') {
      requireOperator(req);
      const body = await readJson(req);
      const out = await sessions.create(baseUrl(req), typeof body.sessionId === 'string' ? body.sessionId.toUpperCase() : undefined);
      logger.info('session_created', { sessionId: out.sessionId });
      return sendJson(req, res, 201, { ...out, code: out.sessionId, wsPath: '/ws' });     // `code` se conserva por compatibilidad con V3.0
    }
    if (m === 'GET' && p === '/api/sessions') {
      requireOperator(req);
      return sendJson(req, res, 200, { sessions: await sessions.list(50) });
    }

    const sm = p.match(/^\/api\/sessions\/([A-Za-z0-9]{6})(?:\/(master-token|revoke|status))?$/);
    if (sm) {
      const id = sm[1].toUpperCase();
      if (!SESSION_RE.test(id)) return sendJson(req, res, 404, { error: 'SESSION_NOT_FOUND' });
      const action = sm[2];
      if (m === 'POST' && action === 'master-token') { requireOperator(req); return sendJson(req, res, 200, await sessions.mintMasterToken(id, baseUrl(req))); }
      if (m === 'POST' && action === 'revoke') { requireOperator(req); logger.warn('master_tokens_revoked', { sessionId: id }); return sendJson(req, res, 200, await sessions.revokeMasterTokens(id)); }
      if (m === 'GET' && action === 'status') {
        const rec = await sessions.get(id);
        if (!rec) { badJoinLimiter.hit(ip); return sendJson(req, res, 404, { error: 'SESSION_NOT_FOUND' }); }
        const t = auth.bearer(req);
        if (t && auth.verifyOperator(t)) {
          const total = await store.presenceTotal(id);
          return sendJson(req, res, 200, { sessionId: id, state: rec.state, strobeEnabled: rec.strobeEnabled, connected: total, createdAt: rec.createdAt });
        }
        return sendJson(req, res, 200, { sessionId: id, exists: true });    // el público solo puede saber si la sesión existe
      }
    }

    // Interruptor de la app Flash (solo operador). La URL pública de la app Flash es /flash; el QR lo arma el panel con un código propio.
    if (p === '/api/admin/flash' && (m === 'GET' || m === 'POST')) {
      requireOperator(req);
      if (m === 'POST') {
        const body = await readJson(req);
        if (typeof body.enabled !== 'boolean') return sendJson(req, res, 400, { error: 'INVALID_BODY', message: 'Se esperaba { "enabled": true | false }' });
        await store.setSetting('flashEnabled', body.enabled ? '1' : '0');       // se guarda ANTES de aplicarlo: si el almacenamiento falla, no queda a medias
        flashEnabled = body.enabled;
        metrics.inc('flash_toggled'); logger.info('flash_toggled', { enabled: flashEnabled });
      }
      return sendJson(req, res, 200, { enabled: flashEnabled, defaultEnabled: Boolean(config.flashDefaultEnabled), path: '/flash', url: `${baseUrl(req)}/flash` });
    }

    if (m === 'GET' && p === '/api/admin/status') {
      requireOperator(req);
      return sendJson(req, res, 200, { version: VERSION, health: getHealth(), hub: { ...hub.stats(), internals: hub.debugCounts() }, metrics: metrics.snapshot(), store: { ...lastStore, config: storeConfig() }, flash: { enabled: flashEnabled }, instance: config.instanceId, cluster: { workerId: process.env.NODE_UNIQUE_ID || null }, sessions: await store.countSessions().catch(() => null) });
    }

    if (m === 'GET' || m === 'HEAD') return serveStatic(req, res, p, u.searchParams);
    return sendJson(req, res, 404, { error: 'NOT_FOUND' });
  }

  const server = http.createServer(async (req, res) => {
    const t0 = process.hrtime.bigint();
    const reqId = /^[A-Za-z0-9_-]{6,64}$/.test(req.headers['x-request-id'] || '') ? req.headers['x-request-id'] : crypto.randomBytes(6).toString('hex');
    res.setHeader('x-request-id', reqId);
    const ip = clientIp(req);
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
    try {
      const isStaticAsset = (req.method === 'GET' || req.method === 'HEAD') && !u.pathname.startsWith('/api/') && u.pathname !== '/metrics' && u.pathname !== '/healthz' && u.pathname !== '/readyz';
      const exempt = u.pathname === '/healthz' || u.pathname === '/readyz';
      const allowed = exempt || (isStaticAsset ? (!staticLimiter || staticLimiter.hit(ip)) : httpLimiter.hit(ip));
      if (!allowed) {
        metrics.inc('http_rate_limited');
        return sendJson(req, res, 429, { error: 'RATE_LIMITED' }, { 'retry-after': '30' });
      }
      await route(req, res, u, ip);
    } catch (e) {
      if (e instanceof SessionError || e.status) {
        if (!res.headersSent) sendJson(req, res, e.status || 400, { error: e.code || 'BAD_REQUEST', message: e.message });
      } else {
        logger.error('http_error', { reqId, path: u.pathname, error: e.message });
        if (!res.headersSent) sendJson(req, res, 500, { error: 'SERVER_ERROR' });     // nunca se devuelve el detalle interno
      }
    } finally {
      metrics.inc('http_requests');
      metrics.observe('httpMs', Number(process.hrtime.bigint() - t0) / 1e6);
    }
  });
  // Evita sockets HTTP colgados (slowloris) sin cortar las conexiones WebSocket ya promovidas.
  server.headersTimeout = 15000; server.requestTimeout = 30000; server.keepAliveTimeout = 65000;

  // ------------------------------------------------------------------ WebSocket (upgrade controlado)
  const wss = new WebSocket.Server({ noServer: true, maxPayload: config.maxMessageBytes, perMessageDeflate: false, clientTracking: false });

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return config.allowNoOrigin;
    let o; try { o = new URL(origin); } catch { return false; }
    if (config.allowedOrigins.includes(origin)) return true;
    if (config.publicBaseUrl && new URL(config.publicBaseUrl).host === o.host) return true;
    return o.host === req.headers.host;
  }

  function refuse(socket, status, text) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    const ip = clientIp(req);
    socket.on('error', () => {});
    let u; try { u = new URL(req.url, 'http://localhost'); } catch { return refuse(socket, 400, 'Bad Request'); }
    if (u.pathname !== '/ws') return refuse(socket, 404, 'Not Found');
    if (hub.draining) { metrics.inc('ws_rejected_draining'); return refuse(socket, 503, 'Service Unavailable'); }
    if (hub.connectionCount >= config.maxConnections) { metrics.inc('ws_rejected_capacity'); return refuse(socket, 503, 'Service Unavailable'); }
    if (!originAllowed(req)) { metrics.inc('ws_rejected_origin'); logger.warn('ws_origin_rejected', { ip, origin: String(req.headers.origin || '').slice(0, 120) }); return refuse(socket, 403, 'Forbidden'); }
    const ipSt = hub.ipState(ip);
    if (ipSt.pre >= config.preHelloMaxPerIp) { metrics.inc('ws_rejected_prehello'); return refuse(socket, 429, 'Too Many Requests'); }
    if (config.maxConnPerIp > 0 && ipSt.total >= config.maxConnPerIp) { metrics.inc('ws_rejected_ipcap'); return refuse(socket, 429, 'Too Many Requests'); }
    if (!wsConnLimiter.hit(ip)) { metrics.inc('ws_rejected_rate'); return refuse(socket, 429, 'Too Many Requests'); }
    if (!badJoinLimiter.peek(ip)) { metrics.inc('ws_rejected_badjoin'); return refuse(socket, 429, 'Too Many Requests'); }
    wss.handleUpgrade(req, socket, head, ws => {
      // Compatibilidad V3.0: /ws?session=CODIGO&role=public&deviceId=ID (sin hello). Solo para participantes.
      let legacy = null;
      const qs = u.searchParams;
      if (qs.get('session') && qs.get('role') === 'public') {
        const sid = String(qs.get('session')).toUpperCase(); const did = String(qs.get('deviceId') || '');
        if (SESSION_RE.test(sid)) legacy = { sessionId: sid, deviceId: /^[A-Za-z0-9_-]{8,80}$/.test(did) ? did : undefined };
      }
      const conn = hub.accept(ws, req, ip, legacy);
      conn.onBadJoin = () => badJoinLimiter.hit(ip);
    });
  });

  // ------------------------------------------------------------------ ciclo de vida
  async function start() {
    await store.init();
    await pollStore();
    hub.start();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, config.listenBacklog, resolve); });
    const addr = server.address();
    logger.info('listening', { version: VERSION, host: config.host, port: addr.port, store: store.kind, storeConfig: storeConfig(), node: process.version, instance: config.instanceId });
    return addr;
  }

  // Apagado ordenado (SIGTERM): deja de aceptar, avisa a los clientes, cierra escalonado y libera recursos.
  async function shutdown(reason = 'SIGTERM') {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_start', { reason, connections: hub.connectionCount });
    server.close();                                 // deja de aceptar nuevas conexiones TCP
    const deadline = Date.now() + config.shutdownGraceMs;
    try { await Promise.race([hub.drain(Math.min(config.shutdownSpreadMs, config.shutdownGraceMs)), new Promise(r => setTimeout(r, config.shutdownGraceMs))]); } catch (e) { logger.error('drain_failed', { error: e.message }); }
    while (hub.connectionCount > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    hub.stop(); clearInterval(sweeper); clearInterval(storeTimer);
    try { await store.close(); } catch { /* ya cerrado */ }
    metrics.stop();
    logger.info('shutdown_done', { remaining: hub.connectionCount });
  }

  return { config, server, wss, hub, store, metrics, auth, sessions, logger, start, shutdown, getHealth, address: () => server.address() };
}

module.exports = { createApp };
