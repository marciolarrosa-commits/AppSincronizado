/* Destello·Sync — cliente del público (pantalla controlada por el Master).
 * Protocolo: docs/PROTOCOLO.md (v1). Conexión WebSocket única, reloj sincronizado con el servidor, estado autoritativo,
 * reconexión con backoff exponencial + jitter y recuperación del estado vigente.
 *
 * MODOS (separación entre la interfaz de incorporación y la superficie lumínica):
 *   - "preshow": pantalla negra con la interfaz de incorporación (estado de conexión, código de sesión si falta, botón «Entrar al espectáculo»,
 *     consejos de pantalla completa). Se sale de ella al tocar el botón o AUTOMÁTICAMENTE al aplicarse la primera orden distinta de "apagado".
 *   - "show" (modo espectáculo): la capa lumínica (#remote-light) ocupa TODO el viewport y NO hay ningún elemento de interfaz por encima. El primer
 *     toque intenta pantalla completa (requiere gesto). 5 toques seguidos (≤ 2,5 s) o la tecla Esc abren un panel de diagnóstico con salida segura
 *     («Volver al espectáculo», «Salir»); el panel se cierra solo a los 10 s. Tras una reconexión se conserva el modo; solo si pasan más de 10 s
 *     sin conexión aparece una pastilla mínima «Sin conexión» (los efectos animados ya están congelados en color fijo).
 *
 * Limitación conocida (no es un defecto de esta app): iOS y Android suspenden WebSockets y animaciones cuando el navegador
 * queda en segundo plano o la pantalla se bloquea. Se usa Wake Lock cuando el navegador lo permite, pero no hay garantía
 * de recibir órdenes con la pantalla apagada. Al volver, el cliente se reconecta y aplica el estado vigente.
 */
(function () {
  'use strict';
  var FX = window.DestelloEffects;
  var PROTOCOL = 1;
  var BACKOFF_BASE_MS = 1000, BACKOFF_CAP_MS = 30000, BACKOFF_FLOOR_MS = 250;
  var STALE_AFTER_MS = 10000;          // sin conexión más de esto -> se detienen los efectos animados y (en modo espectáculo) aparece el aviso mínimo
  var BANNER_AFTER_MS = 1500;          // en la pantalla de incorporación: sin conexión más de esto -> aviso visible
  var PANEL_TIMEOUT_MS = 10000, TAPS_TO_PANEL = 5, TAP_WINDOW_MS = 2500, FS_RETRY_MS = 3000;
  var PLAT = window.DestelloPlatform;
  var CLK = window.DestelloClock;         // estimación del reloj del servidor (módulo puro: public/js/clock.js)
  var DEBUG = /[?&]debug=1/.test(location.search);

  var el = {};
  var S = {
    code: null, ws: null, attempts: 0, everConnected: false, reconnectTimer: null, closedByUser: false, fatal: null,
    lastVersion: -1, current: null, pending: null, from: null, shown: [0, 0, 0], appliedMeta: null,
    clock: { offset: 0, bestRtt: Infinity, samples: [], synced: false },
    config: { clockPingIntervalMs: 30000, heartbeatMs: 20000 }, incarnation: undefined, animating: false, discTimers: [], connected: false, disconnectedAt: 0, lastPongAt: 0, pingTimer: null, watchdog: null,
    effectsOff: false, reduced: false, raf: 0, wakeLock: null, wake: { state: 'idle', error: null, tries: 0, pending: false, timer: null, grants: 0 }, hintDelay: null, lastRtt: null, stats: { applied: 0, ignored: 0, lateArrivals: 0 },
    mode: 'preshow', panelOpen: false, panelTimer: null, taps: [], autoShow: !/[?&]show=0/.test(location.search), bannerText: null, lastCss: null, chromeCss: null, chromeAt: 0,
    env: null, fs: { api: 'none', requested: false, state: 'none', reason: null, lastTry: 0 }, viewport: { w: 0, h: 0, dpr: 1 }
  };
  try { S.effectsOff = localStorage.getItem('destello-effects-off') === '1'; } catch (e) { /* almacenamiento bloqueado */ }
  try { S.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* sin matchMedia */ }

  // ---------------------------------------------------------------- utilidades
  function perfNow() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  // Hora del servidor = reloj monotónico local + desplazamiento estimado (no se usa el reloj del teléfono como autoridad).
  function serverNow() { return perfNow() + S.clock.offset; }
  function deviceId() {
    var key = 'destello-sync-device-id';
    var re = /^[A-Za-z0-9_-]{8,80}$/;
    try {
      var v = localStorage.getItem(key);
      if (v && re.test(v)) return v;
      var g = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2));
      localStorage.setItem(key, g); return g;
    } catch (e) { return 'd-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  }
  var DEVICE = deviceId();
  function log() { if (DEBUG && window.console) console.log.apply(console, ['[destello]'].concat([].slice.call(arguments))); }

  // ---------------------------------------------------------------- interfaz
  function ui() {
    el.stage = document.getElementById('remote-stage');
    el.light = document.getElementById('remote-light');          // CAPA LUMÍNICA principal (única que recibe colores)
    el.ui = document.getElementById('remote-ui');                // capa de interfaz (incorporación / panel de diagnóstico)
    el.session = document.getElementById('remote-session');
    el.conn = document.getElementById('remote-connection');
    el.label = document.getElementById('remote-label');
    el.banner = document.getElementById('remote-banner');
    el.bannerText = document.getElementById('remote-banner-text');
    el.enter = document.getElementById('remote-enter');
    el.fs = document.getElementById('remote-fullscreen');
    el.fx = document.getElementById('remote-effects');
    el.back = document.getElementById('remote-back');
    el.exit = document.getElementById('remote-exit');
    el.advice = document.getElementById('remote-advice');
    el.diag = document.getElementById('remote-diag');
    el.joinForm = document.getElementById('remote-join-form');
    el.code = document.getElementById('remote-code');
    el.codeError = document.getElementById('remote-code-error');
    el.debug = document.getElementById('remote-debug');
    el.theme = document.querySelector('meta[name="theme-color"]');
  }
  function setConn(text, good) { if (el.conn) { el.conn.textContent = text; el.conn.className = good ? 'connected' : ''; } }

  // Aviso de conexión: en la pantalla de incorporación se ve enseguida; en modo espectáculo SOLO si el corte dura más de STALE_AFTER_MS (o es fatal).
  function setBanner(text, short) { S.bannerText = text || null; S.bannerShort = short || 'Sin conexión'; updateBanner(); }
  function updateBanner() {
    if (!el.banner) return;
    var offlineFor = S.disconnectedAt ? Date.now() - S.disconnectedAt : 0;
    var show = Boolean(S.bannerText) && (S.mode !== 'show' || S.fatal || offlineFor >= STALE_AFTER_MS);
    if (show) { el.bannerText.textContent = S.mode === 'show' ? S.bannerShort : S.bannerText; el.banner.hidden = false; } else el.banner.hidden = true;
    el.banner.classList.toggle('compact', S.mode === 'show');
  }
  function paintFxButton() { if (el.fx) el.fx.textContent = S.effectsOff ? 'Efectos: desactivados' : 'Efectos: activados'; }

  // La interfaz solo es visible en la pantalla de incorporación o con el panel abierto. En modo espectáculo NADA queda por encima del color.
  function renderUi() {
    var visible = S.mode === 'preshow' || S.panelOpen;
    if (el.ui) { el.ui.hidden = !visible; el.ui.classList.toggle('panel', S.mode === 'show' && S.panelOpen); el.ui.setAttribute('aria-hidden', visible ? 'false' : 'true'); }
    if (el.stage) { el.stage.classList.toggle('mode-show', S.mode === 'show'); el.stage.classList.toggle('mode-preshow', S.mode === 'preshow'); }
    document.documentElement.classList.toggle('show-mode', S.mode === 'show');
    var hasCode = Boolean(S.code);
    if (el.joinForm) el.joinForm.hidden = hasCode || S.mode === 'show';
    if (el.enter) el.enter.hidden = !hasCode || S.mode === 'show';
    if (el.back) el.back.hidden = S.mode !== 'show';
    if (el.label) el.label.hidden = S.mode === 'show';
    if (el.session) el.session.textContent = hasCode ? 'SESIÓN ' + S.code : 'SIN SESIÓN';
    if (el.advice && S.env) el.advice.textContent = PLAT.advice(S.env, S.fs.api).text;
    paintDiag(); updateBanner();
  }
  function colorLine() {
    var env = colorEnv(); var painted = '?';
    try { if (el.light) painted = getComputedStyle(el.light).backgroundColor; } catch (e) { /* sin estilo */ }
    var calc = 'rgb(' + Math.round(S.shown[0]) + ', ' + Math.round(S.shown[1]) + ', ' + Math.round(S.shown[2]) + ')';
    return 'Color: calculado ' + calc + ' · pintado ' + painted + ' · tema ' + (env.dark ? 'oscuro' : 'claro') + (env.forced ? ' · COLORES FORZADOS' : '') + ' · gama ' + env.gamut + (env.hdr ? ' · HDR' : '') + ' · ' + env.depth + ' bits';
  }
  function paintDiag() {
    if (!el.diag) return;
    // Diagnóstico: SOLO con el panel abierto (o en la pantalla de incorporación si el enlace lleva debug=1). En modo espectáculo nunca queda encima del color.
    var show = S.panelOpen || (DEBUG && S.mode === 'preshow');
    el.diag.hidden = !show; if (el.debug) el.debug.hidden = !show;
    if (!show) return;
    var fsText = S.fs.api === 'none' ? 'no disponible en este navegador' : (PLAT.isFullscreen(document) ? 'activa' : (S.fs.state === 'rejected' ? 'rechazada (' + S.fs.reason + ')' : (S.fs.requested ? 'solicitada' : 'sin solicitar')));
    el.diag.textContent = ['Sesión ' + (S.code || '—') + ' · versión ' + S.lastVersion + ' · ' + (S.connected ? 'conectado' : 'sin conexión'),
      'Pantalla ' + S.viewport.w + '×' + S.viewport.h + ' CSS px · ×' + S.viewport.dpr + ' · ' + (S.env ? S.env.displayMode : '?'),
      'Pantalla completa: ' + fsText, 'Pantalla encendida (Wake Lock): ' + wakeText(),
      colorLine(), 'Reloj: desfase ' + Math.round(S.clock.offset) + ' ms · RTT ' + (S.lastRtt == null ? '—' : Math.round(S.lastRtt)) + ' ms · fuente ' + (S.clock.source || '—') + ' · error ≤ ' + (isFinite(S.clock.bestRtt) ? Math.round(S.clock.bestRtt / 2) + ' ms' : '—')].join('\n');
  }
  function measureViewport() {
    S.viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
    paintDiag();
  }

  // ---------------------------------------------------------------- modos, panel y pantalla completa
  function setMode(m) { S.mode = m; renderUi(); ensureLoop(); }
  function enterShow(fromGesture) {
    if (!S.code) return;
    S.panelOpen = false; clearTimeout(S.panelTimer);
    setMode('show');
    if (fromGesture) tryFullscreen();
  }
  function openPanel() {
    S.panelOpen = true; S.panelOpenedAt = Date.now(); renderUi();
    clearTimeout(S.panelTimer); S.panelTimer = setTimeout(closePanel, PANEL_TIMEOUT_MS);
  }
  function closePanel() { S.panelOpen = false; clearTimeout(S.panelTimer); renderUi(); ensureLoop(); }
  function tryFullscreen() {
    S.fs.api = PLAT.fullscreenApi(document);
    var t = Date.now();
    if (S.fs.api === 'none' || PLAT.isFullscreen(document) || t - S.fs.lastTry < FS_RETRY_MS) { paintDiag(); return Promise.resolve(); }
    S.fs.lastTry = t; S.fs.requested = true;
    return PLAT.requestFullscreen(document).then(function (r) {
      S.fs.state = r.ok ? 'accepted' : 'rejected'; S.fs.reason = r.ok ? null : r.reason; S.fs.api = r.api;
      log('pantalla completa', r.ok, r.reason); paintDiag(); onViewportChange();
    });
  }
  // Toques sobre la superficie: el primero pide pantalla completa (gesto válido); cinco seguidos abren el panel de diagnóstico.
  function onSurfaceTap(ev) {
    if (S.mode !== 'show' || S.panelOpen) return;
    var t = Date.now();
    S.taps = S.taps.filter(function (x) { return t - x < TAP_WINDOW_MS; }); S.taps.push(t);
    if (S.taps.length >= TAPS_TO_PANEL) { S.taps = []; openPanel(); return; }
    tryFullscreen();
  }
  function onViewportChange() { measureViewport(); ensureLoop(); }     // el fondo es CSS (inset:0): el cambio no reinicia ninguna fase (el tiempo manda)

  // Al abrir el panel con el quinto toque, el dedo sigue sobre la pantalla: los botones ignoran toques durante 700 ms (evita pulsar «Salir» sin querer)
  // y «Salir» pide confirmación (segundo toque en 3 s).
  function guarded(fn) { return function (ev) { if (S.panelOpen && Date.now() - (S.panelOpenedAt || 0) < 700) return; fn(ev); }; }
  function confirmExit() {
    if (S.exitArmed) { S.exitArmed = false; clearTimeout(S.exitTimer); if (el.exit) el.exit.textContent = 'Salir'; leave(); return; }
    S.exitArmed = true; if (el.exit) el.exit.textContent = 'Tocá de nuevo para salir';
    clearTimeout(S.exitTimer); S.exitTimer = setTimeout(function () { S.exitArmed = false; if (el.exit) el.exit.textContent = 'Salir'; }, 3000);
  }

  function leave() {
    S.closedByUser = true; clearTimeout(S.reconnectTimer); clearTimeout(S.pingTimer); clearInterval(S.watchdog); clearDisconnectTimers(); clearTimeout(S.panelTimer);
    if (S.ws) { try { S.ws.onclose = null; S.ws.close(1000); } catch (e) { /* ya cerrado */ } S.ws = null; }
    clearTimeout(S.wake.timer);
    try { if (S.wakeLock) S.wakeLock.release(); } catch (e) { /* ignorado */ }
    PLAT.exitFullscreen(document);
    S.connected = false; S.mode = 'preshow'; S.panelOpen = false;
    if (el.stage) el.stage.classList.remove('active');
    document.documentElement.classList.remove('show-mode', 'remote-on');
    document.documentElement.style.backgroundColor = ''; document.body.style.backgroundColor = '';
    if (typeof window.DestelloRemote.onExit === 'function') window.DestelloRemote.onExit();
  }

  // ---------------------------------------------------------------- reloj (estilo NTP, quedándose con la muestra de menor RTT)
  function onPong(msg) {
    var t1 = perfNow();
    var r = CLK.addPong(S.clock.samples, msg, t1);
    if (!r) return;
    S.lastRtt = r.rtt; S.lastPongAt = Date.now();
    // Se queda con la muestra de menor RTT (servidor − perf local); las viejas se renuevan al salir de la ventana de 12.
    S.clock.offset = r.best.offset; S.clock.bestRtt = r.best.rtt; S.clock.synced = true; S.clock.source = 'pong';
  }
  // Un ping por intervalo (con jitter ±15 % para que los teléfonos no se sincronicen entre sí): a 60 000 clientes y 30 s son ~2 000 ping/s en total.
  function schedulePing() {
    clearTimeout(S.pingTimer);
    var base = S.config.clockPingIntervalMs || 30000;
    S.pingTimer = setTimeout(function () { sendPing(); schedulePing(); }, base * (0.85 + Math.random() * 0.3));
  }
  // `rtt` (opcional) = mejor RTT conocido: cota del error del reloj (≤ RTT/2). El servidor lo agrega en un histograma para saber qué tan buena es la sincronía del público.
  function sendPing() { rawSend({ protocolVersion: PROTOCOL, type: 'ping', t0: perfNow(), rtt: isFinite(S.clock.bestRtt) ? Math.round(S.clock.bestRtt) : undefined }); }
  function clockBurst() { for (var i = 0; i < 6; i++) setTimeout(sendPing, i * 120); }

  // ---------------------------------------------------------------- aplicación de estados
  function onState(st, meta) {
    meta = meta || {};
    if (!st || typeof st.stateVersion !== 'number' || !FX.validPayload(st.payload)) { S.stats.invalid = (S.stats.invalid || 0) + 1; return; }   // mensaje malformado: se ignora
    // Si la sesión se perdió y se re-creó con el mismo código, las versiones vuelven a empezar: se reinicia la línea base en vez de descartar todo como "viejo".
    if (typeof st.incarnation === 'number') {
      if (S.incarnation !== undefined && st.incarnation !== S.incarnation) S.lastVersion = -1;
      S.incarnation = st.incarnation;
    }
    if (!meta.initial) {
      // Idempotencia y orden: se descartan duplicados y versiones anteriores a la ya recibida.
      if (st.stateVersion <= S.lastVersion) { S.stats.ignored++; log('estado descartado v' + st.stateVersion); return; }
    }
    S.lastVersion = st.stateVersion;
    var now = serverNow();
    var lead = st.executeAt - now;
    st = { commandId: st.commandId, stateVersion: st.stateVersion, executeAt: st.executeAt, payload: st.payload, ackRate: meta.ackRate || 0, resync: !!meta.resync, receiveLeadMs: Math.round(lead), initial: !!meta.initial };
    if (lead < 0 && !meta.initial && !meta.resync) S.stats.lateArrivals++;
    if (lead <= 0 || st.payload.effect === 'off') applyState(st, now);
    else {
      // La orden todavía no debe ejecutarse (también si llegó en la bienvenida o en un reenvío): se programa para su instante.
      // Un dispositivo recién conectado muestra pantalla apagada hasta entonces; así nadie se adelanta al resto.
      if (meta.initial) applyState({ commandId: 'init', stateVersion: -1, executeAt: 0, payload: { effect: 'off', color: '#000000', color2: '#000000', intensity: 1 }, ackRate: 0, initial: true }, now);
      S.pending = st;                          // reemplaza a cualquier orden pendiente anterior (solo importa la más reciente)
    }
    ensureLoop();
  }
  function applyState(st, now) {
    S.from = S.shown.slice();
    S.current = st; S.pending = null;
    S.appliedMeta = { version: st.stateVersion, at: now, deviation: now - st.executeAt, wallAt: Date.now() };   // wallAt: solo diagnóstico/pruebas
    S.stats.applied++;
    if (el.label) el.label.textContent = st.payload.effect === 'off' ? 'Esperando al show' : '';
    if (S.autoShow && S.mode === 'preshow' && S.code && st.payload.effect !== 'off') enterShow(false);      // la primera orden visible activa el modo espectáculo
    reportApplied(st, now);
  }
  function reportApplied(st, now) {
    if (st.initial || st.resync || !(st.ackRate > 0) || Math.random() > st.ackRate) return;
    var dev = Math.round(now - st.executeAt);
    // El reporte se envía unos ms después (con jitter) para no producir una ráfaga simultánea de confirmaciones.
    setTimeout(function () {
      rawSend({ protocolVersion: PROTOCOL, type: 'applied', commandId: st.commandId, stateVersion: st.stateVersion,
        deviationMs: Math.max(-60000, Math.min(60000, dev)), receiveLeadMs: Math.max(-60000, Math.min(60000, st.receiveLeadMs)) });
    }, 50 + Math.random() * 350);
  }

  // Un solo bucle de render: evalúa el estado con el reloj sincronizado (por eso no hay animaciones CSS desfasadas).
  // CPU/batería: el bucle SOLO corre mientras hay algo que animar (transición, pulso, strobe) o una orden pendiente; con un color fijo
  // se detiene por completo y se reactiva con una orden nueva, al volver la pestaña o al cambiar un ajuste. Pulso/transición a ~30 fps; strobe a 60.
  function ensureLoop() { if (!S.raf && !document.hidden) S.raf = requestAnimationFrame(frame); }
  function frame(ts) {
    S.raf = 0;
    var now = serverNow();
    if (S.pending && now >= S.pending.executeAt) applyState(S.pending, now);
    var stale = !S.connected && S.disconnectedAt && (Date.now() - S.disconnectedAt > STALE_AFTER_MS);
    var calm = S.effectsOff || S.reduced;
    var animated = false; var flashing = false; var nextHint = null;
    if (S.current && el.stage) {
      var r;
      try { r = FX.evaluate(S.current, now, { from: S.from, reduced: calm, stale: stale, manualOff: S.effectsOff, systemReduced: S.reduced }); }
      catch (e) { r = { rgb: [0, 0, 0], animated: false, flashing: false }; S.stats.evalErrors = (S.stats.evalErrors || 0) + 1; }   // ante cualquier fallo: estado seguro (apagado), nunca un bucle roto
      S.shown = r.rgb; animated = r.animated; flashing = r.flashing; S.animating = animated; if (typeof r.next === 'number') nextHint = r.next;
      paintLight(r.rgb, animated);
    }
    if (DEBUG && el.debug && !el.debug.hidden) {
      el.debug.textContent = 'v' + S.lastVersion + ' off=' + Math.round(S.clock.offset) + 'ms rtt=' + (S.lastRtt == null ? '-' : Math.round(S.lastRtt)) +
        ' dev=' + (S.appliedMeta ? Math.round(S.appliedMeta.deviation) : '-') + ' ign=' + S.stats.ignored + ' wake=' + S.wake.state + ' raf=' + (animated || S.pending ? 'on' : 'off');
    }
    if (S.pending || flashing) ensureLoop();                         // órdenes pendientes y strobe: a 60 fps para respetar su temporización
    else if (animated && nextHint !== null) {
      // Secuencia: el color solo cambia en las fronteras de cada paso. Entre fronteras no se dibuja (ahorra CPU/batería) y se despierta ~40 ms ANTES de la
      // frontera para evaluar en cada cuadro (60 fps) y pintar en el primer cuadro posterior: el retraso de dibujo queda ≤ 1 cuadro (antes hasta ~35 ms por el
      // sondeo a ~30 fps).
      clearTimeout(S.wakeT);
      if (nextHint > 80) S.wakeT = setTimeout(ensureLoop, nextHint - 40); else ensureLoop();
    }
    else if (animated) setTimeout(ensureLoop, 22);                   // pulso/transición: ~30 fps (menos CPU y batería)
    // pestaña oculta: ensureLoop no hace nada; se retoma en visibilitychange
  }
  // Única escritura de color: la capa lumínica ocupa TODO el viewport. Para que nada del navegador muestre otro color (rebote de scroll de iOS,
  // áreas bajo barras translúcidas, barra de direcciones tintada) también se sincronizan el fondo de <html>/<body> y <meta name="theme-color">;
  // esto último se limita a ~4 veces por segundo durante animaciones.
  function paintLight(rgb, animated) {
    var css = FX.css(rgb);
    if (css !== S.lastCss) {
      S.lastCss = css;
      if (el.light) el.light.style.backgroundColor = css;
      if (el.stage) el.stage.style.backgroundColor = css;
    }
    if (css === S.chromeCss) return;                          // el documento/theme-color ya muestran este color
    var t = Date.now();
    if (animated && t - S.chromeAt < 250) return;             // durante animaciones: ~4 actualizaciones por segundo; el cuadro final (animated=false) siempre escribe
    S.chromeAt = t; S.chromeCss = css;
    document.documentElement.style.backgroundColor = css; if (document.body) document.body.style.backgroundColor = css;
    if (el.theme) el.theme.setAttribute('content', PLAT.toHex(rgb));
  }
  // Aviso de desconexión y paso a "estado seguro" sin necesidad de un bucle permanente: dos temporizadores.
  function armDisconnectTimers() {
    clearDisconnectTimers();
    S.discTimers.push(setTimeout(function () { if (!S.connected) setBanner(S.fatal || 'Sin conexión: reconectando. No se pueden garantizar nuevas órdenes.', S.fatal ? 'Pestaña duplicada' : 'Sin conexión'); }, BANNER_AFTER_MS));
    S.discTimers.push(setTimeout(function () { if (!S.connected) { updateBanner(); ensureLoop(); } }, STALE_AFTER_MS + 50));     // repinta con los efectos ya "congelados"
  }
  function clearDisconnectTimers() { S.discTimers.forEach(clearTimeout); S.discTimers = []; }

  // ---------------------------------------------------------------- conexión
  function rawSend(obj) {
    if (S.ws && S.ws.readyState === 1) { try { S.ws.send(JSON.stringify(obj)); return true; } catch (e) { /* cerrando */ } }
    return false;
  }
  function backoff(hint) {
    if (typeof hint === 'number') return hint;
    S.attempts++;
    var cap = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, Math.min(S.attempts - 1, 6)));
    return Math.max(BACKOFF_FLOOR_MS, Math.random() * cap);            // "full jitter": evita que miles de teléfonos reconecten a la vez
  }
  function scheduleReconnect(hintMs, why) {
    if (S.closedByUser || S.fatal || S.reconnectTimer) return;
    var d = backoff(hintMs);
    setConn('● RECONECTANDO ' + Math.max(1, Math.ceil(d / 1000)) + 's', false);
    log('reconectar en', Math.round(d), why);
    S.reconnectTimer = setTimeout(function () { S.reconnectTimer = null; connect(); }, d);
  }

  function connect() {
    if (S.closedByUser) return;
    if (S.ws) { try { S.ws.onclose = null; S.ws.close(); } catch (e) { /* ya cerrado */ } S.ws = null; }
    clearTimeout(S.pingTimer);
    var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws;
    try { ws = new WebSocket(scheme + '//' + location.host + '/ws'); }      // sin datos sensibles en la URL
    catch (e) { return scheduleReconnect(undefined, 'ctor'); }
    S.ws = ws; S.connectAt = Date.now();
    setConn(S.everConnected ? '● RECONECTANDO' : '● CONECTANDO', false);
    var opened = false;
    ws.onopen = function () {
      opened = true; S.helloAt = perfNow();                       // para estimar el reloj con el viaje hello→welcome
      ws.send(JSON.stringify({ protocolVersion: PROTOCOL, type: 'hello', role: 'public', sessionId: S.code, deviceId: DEVICE,
        resumeVersion: Math.max(0, S.lastVersion), reconnect: S.everConnected }));
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      S.lastPongAt = Date.now();
      switch (m.type) {
        case 'welcome':
          S.connected = true; S.everConnected = true; S.attempts = 0; S.disconnectedAt = 0; S.fatal = null; S.discArmed = false; clearDisconnectTimers();
          S.config = Object.assign(S.config, m.config || {});
          // Estimación inicial grosera con el reloj del servidor; se afina enseguida con ping/pong de menor RTT.
          // Antes: offset = serverTimestamp − ahora, que IGNORA la demora de bajada del welcome (decenas/cientos de ms de error hasta el primer pong): un teléfono que
          // se une a mitad de la secuencia mostraba una fase atrasada y luego saltaba. Ahora se compensa con el viaje hello→welcome (RTT/2) y, al reconectar,
          // se conserva la estimación previa (de menor RTT) si es coherente.
          var est = CLK.fromWelcome({ serverTimestamp: m.serverTimestamp, recvAt: perfNow(), helloAt: S.helloAt, prevOffset: S.clock.offset, prevSynced: S.clock.synced });
          S.clock.samples = []; S.clock.offset = est.offset; S.clock.source = est.source;
          setConn('● CONECTADO', true); setBanner(null);
          S.lastVersion = -1;                                         // la bienvenida es autoritativa (también tras un reinicio del servidor)
          onState(m.state, { initial: true });
          clockBurst();
          clearTimeout(S.pingTimer);
          schedulePing();
          break;
        case 'pong': onPong(m); break;
        case 'state': onState(m, { ackRate: m.ackRate, resync: m.resync }); break;
        case 'restart': scheduleReconnect(Math.max(500, Math.min(15000, Number(m.reconnectAfterMs) || 2000)), 'restart'); break;
        case 'error': log('error', m.code); break;
        default: break;
      }
    };
    ws.onerror = function () { /* el cierre posterior dispara la reconexión */ };
    ws.onclose = function (ev) {
      if (S.ws === ws) S.ws = null;
      var wasConnected = S.connected;
      S.connected = false; if (wasConnected || !S.disconnectedAt) S.disconnectedAt = Date.now();
      clearTimeout(S.pingTimer);
      if (wasConnected || !S.discArmed) { S.discArmed = true; armDisconnectTimers(); }
      log('cerrado', ev.code, ev.reason);
      if (S.closedByUser) return;
      if (ev.code === 4002) { S.fatal = 'Esta sesión se abrió en otra pestaña de este dispositivo.'; setConn('● PESTAÑA DUPLICADA', false); setBanner(S.fatal, 'Pestaña duplicada'); return; }
      if (ev.code === 4404) { setConn('● ESPERANDO AL OPERADOR', false); setBanner('La sesión no está activa. Esperando que el operador la retome…', 'Esperando al operador'); return scheduleReconnect(5000 + Math.random() * 10000, '4404'); }
      if (ev.code === 4429) return scheduleReconnect(10000 + Math.random() * 20000, 'rate');
      scheduleReconnect(undefined, 'close ' + ev.code);
    };
  }

  // Perro guardián: si el servidor no responde (ni pong ni mensajes) se considera la conexión muerta y se reabre.
  function startWatchdog() {
    clearInterval(S.watchdog);
    S.watchdog = setInterval(function () {
      if (S.connected && Date.now() - S.lastPongAt > (S.config.clockPingIntervalMs || 30000) * 2 + 8000) {
        log('watchdog: sin señales'); try { S.ws && S.ws.close(); } catch (e) { /* cerrando */ }
      }
    }, 5000);
  }

  // ---------------------------------------------------------------- eventos del navegador
  // Un intento de conexión RECIÉN iniciado (< 4 s) todavía puede completarse: forzar otra reconexión lo cerraría y haría perder la bienvenida/órdenes en curso.
  // Ocurría al cargar la página: `pageshow` -> onVisible() con el primer WebSocket aún conectando -> reconexión innecesaria que cerraba el socket sano; una orden
  // enviada en esa ventana llegaba como estado «inicial» y ese teléfono no informaba la aplicación. Un socket colgado (> 4 s) sí se reemplaza.
  function connecting() { return Boolean(S.ws && S.ws.readyState === 0 && Date.now() - (S.connectAt || 0) < 4000); }
  function onVisible() {
    if (document.hidden) return;
    ensureLoop(); requestWakeLock();
    if (!S.connected && !connecting() && !S.closedByUser && !S.fatal) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; S.reconnectTimer = setTimeout(function () { S.reconnectTimer = null; connect(); }, Math.random() * 800); }
    else if (S.connected) clockBurst();
  }
  function onOnline() { if (!S.connected && !connecting() && !S.closedByUser && !S.fatal) { clearTimeout(S.reconnectTimer); S.reconnectTimer = setTimeout(function () { S.reconnectTimer = null; connect(); }, Math.random() * 1000); } }
  // Mantener la pantalla encendida: sin esto Android ATENÚA la pantalla antes de apagarla (blanco -> gris, amarillo -> marrón) aunque la página pinte el
  // color exacto. Antes se pedía UNA vez y un rechazo se ignoraba en silencio. Ahora: si falla se reintenta con espera creciente (1 s, 2 s, 4 s … máx. 30 s),
  // si el sistema lo libera se vuelve a pedir, y el estado (y el error) se muestra en el panel de diagnóstico.
  function scheduleWakeRetry(ms) {
    clearTimeout(S.wake.timer);
    if (S.closedByUser) return;
    S.wake.timer = setTimeout(function () { S.wake.timer = null; requestWakeLock(); }, ms);
  }
  function requestWakeLock() {
    var W = S.wake;
    try {
      if (!('wakeLock' in navigator) || !navigator.wakeLock) { W.state = 'unsupported'; paintDiag(); return; }
      if (S.wakeLock || W.pending || document.hidden || S.closedByUser) return;       // oculta: se reintenta al volver (onVisible)
      W.pending = true;
      navigator.wakeLock.request('screen').then(function (l) {
        S.wakeLock = l; W.state = 'active'; W.error = null; W.tries = 0; W.grants++;
        l.addEventListener('release', function () {
          S.wakeLock = null; W.state = 'released'; paintDiag();
          if (!document.hidden) scheduleWakeRetry(500);                               // el sistema lo liberó estando visible: se vuelve a pedir
        });
      }).catch(function (e) {
        W.state = 'denied'; W.error = (e && e.name) || 'error';
        scheduleWakeRetry(Math.min(30000, 1000 * Math.pow(2, W.tries++)));
      }).then(function () { W.pending = false; paintDiag(); });
    } catch (e) { W.state = 'denied'; W.error = (e && e.name) || 'error'; W.pending = false; scheduleWakeRetry(Math.min(30000, 1000 * Math.pow(2, W.tries++))); }
  }
  // Datos de entorno que explican por qué un teléfono muestra otro color o atenúa (se leen del navegador, no se suponen).
  function colorEnv() {
    function mm(q) { try { return window.matchMedia(q).matches; } catch (e) { return false; } }
    return {
      dark: mm('(prefers-color-scheme: dark)'), forced: mm('(forced-colors: active)'), hdr: mm('(dynamic-range: high)'),
      gamut: mm('(color-gamut: rec2020)') ? 'rec2020' : (mm('(color-gamut: p3)') ? 'p3' : 'srgb'), depth: (window.screen && screen.colorDepth) || '?'
    };
  }
  function wakeText() {
    var W = S.wake;
    if (W.state === 'active') return 'activa (pantalla encendida)';
    if (W.state === 'unsupported') return 'NO disponible en este navegador: la pantalla puede atenuarse y apagarse sola';
    if (W.state === 'denied') return 'DENEGADA (' + W.error + '): la pantalla puede atenuarse · reintento ' + W.tries;
    if (W.state === 'released') return 'liberada por el sistema: se vuelve a pedir';
    return 'solicitando…';
  }

  function submitCode(ev) {
    ev.preventDefault();
    var code = PLAT.normalizeCode(el.code && el.code.value);
    if (!code) { if (el.codeError) el.codeError.hidden = false; return; }
    if (el.codeError) el.codeError.hidden = true;
    S.code = code; S.closedByUser = false;
    try { history.replaceState(null, '', '/?s=' + code + '&mode=remote'); } catch (e) { /* sin History API */ }
    renderUi(); startWatchdog(); connect();
  }

  function start(code) {
    ui();
    S.env = PLAT.detect(navigator, window); S.fs.api = PLAT.fullscreenApi(document);
    S.code = PLAT.normalizeCode(code) || ''; S.closedByUser = false; S.mode = 'preshow';
    if (el.stage) el.stage.classList.add('active');
    document.documentElement.classList.add('remote-on');
    // pantalla de incorporación: negro de salida (sin parpadeos de otro color) hasta recibir el estado vigente
    if (el.light) el.light.style.backgroundColor = '#000'; if (el.stage) el.stage.style.backgroundColor = '#000';
    S.current = { commandId: 'init', stateVersion: 0, executeAt: 0, payload: { effect: 'off', color: '#000000', color2: '#000000', intensity: 1 } };
    measureViewport();
    if (el.enter) el.enter.addEventListener('click', guarded(function () { enterShow(true); }));
    if (el.fs) el.fs.addEventListener('click', guarded(function () { S.fs.lastTry = 0; tryFullscreen(); }));
    if (el.back) el.back.addEventListener('click', guarded(function () { closePanel(); tryFullscreen(); }));
    if (el.exit) el.exit.addEventListener('click', guarded(confirmExit));
    if (el.joinForm) el.joinForm.addEventListener('submit', submitCode);
    if (el.fx) { paintFxButton(); el.fx.addEventListener('click', guarded(function () {
      S.effectsOff = !S.effectsOff; try { localStorage.setItem('destello-effects-off', S.effectsOff ? '1' : '0'); } catch (e) { /* bloqueado */ }
      paintFxButton(); ensureLoop();
    })); }
    // gestos sobre la superficie (pointer + touch para WebKit antiguo) y teclado (Esc abre/cierra el panel en escritorio)
    if (el.light) {
      el.light.addEventListener('pointerdown', onSurfaceTap);
      if (!window.PointerEvent) el.light.addEventListener('touchstart', onSurfaceTap, { passive: true });
    }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.mode === 'show') { S.panelOpen ? closePanel() : openPanel(); } });
    // sin zoom por pellizco sobre la superficie (iOS ignora user-scalable=no): evitaría ver los bordes y desplazar el color
    ['gesturestart', 'gesturechange'].forEach(function (n) { document.addEventListener(n, function (e) { if (S.mode === 'show') e.preventDefault(); }, { passive: false }); });
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (n) { document.addEventListener(n, function () { paintDiag(); onViewportChange(); }); });
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', onVisible);
    window.addEventListener('beforeunload', function () { S.closedByUser = true; try { S.ws && S.ws.close(1000); } catch (e) { /* ya cerrado */ } });
    renderUi();
    if (S.code) { startWatchdog(); connect(); }          // sin código (aplicación instalada): se muestra el formulario para ingresarlo
    document.addEventListener('pointerdown', function () { if (!S.wakeLock) requestWakeLock(); }, { passive: true });
    setInterval(function () { if (S.panelOpen) paintDiag(); }, 1000);
    requestWakeLock(); ensureLoop();
  }

  // API mínima, también usada por las pruebas del navegador
  window.DestelloRemote = { start: start, enterShow: enterShow, openPanel: openPanel, closePanel: closePanel, leave: leave, _state: S, _serverNow: serverNow };
})();
