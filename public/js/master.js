/* Destello·Sync — panel Master. Todo el texto dinámico se muestra con textContent (nunca innerHTML).
 * Autenticación: contraseña de operador -> token firmado (sessionStorage de ESTA pestaña) -> token de Master por sesión (solo en memoria).
 */
(function () {
  'use strict';
  var PROTOCOL = 1;
  var $ = function (id) { return document.getElementById(id); };
  var PALETTE = ['#FFFFFF', '#FFD400', '#FF9F1C', '#FF3B30', '#34C759', '#00C7BE', '#0A84FF', '#5856D6', '#AF52DE', '#FF2D55', '#7C4DFF', '#000000'];
  var S = {
    op: null, session: null, masterToken: null, ws: null, attempts: 0, reconnectTimer: null, closing: false,
    color: '#FFD400', effect: 'solid', strobeEnabled: false, maxHz: 3, tracker: DestelloPending.createTracker(), lastAccepted: null, lastStatsVersion: 0, latestVersion: 0, connected: false
  };
  try { S.op = JSON.parse(sessionStorage.getItem('ds-op') || 'null'); } catch (e) { S.op = null; }
  if (S.op && S.op.expiresAt < Date.now()) S.op = null;

  function newId() {
    var a = new Uint8Array(12); (window.crypto || window.msCrypto).getRandomValues(a);
    return 'm' + Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function pill(id, text, cls) { var n = $(id); n.textContent = text; n.className = 'pill' + (cls ? ' ' + cls : ''); }
  function alertBox(kind, text, key) {
    var box = $('alerts'); var old = key && box.querySelector('[data-key="' + key + '"]');
    if (old) old.remove();
    if (!text) return;
    var d = document.createElement('div'); d.className = 'alert ' + kind; d.textContent = text; if (key) d.setAttribute('data-key', key);
    box.appendChild(d);
  }

  // ---------------------------------------------------------------- REST
  function api(method, path, body) {
    var headers = { 'content-type': 'application/json' };
    if (S.op) headers.authorization = 'Bearer ' + S.op.token;
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && path !== '/api/master/login') { logout(true); throw new Error('Sesión de operador vencida: volvé a ingresar'); }
        if (!r.ok) throw new Error(j.message || j.error || ('Error ' + r.status));
        return j;
      });
    });
  }
  function logout(expired) {
    S.op = null; try { sessionStorage.removeItem('ds-op'); sessionStorage.removeItem('ds-sid'); } catch (e) { /* bloqueado */ }
    teardown(); show('loginView', true); show('setupView', false); show('control', false); show('logout', false); show('flashCard', false);
    pill('status', '● sin sesión'); $('loginError').textContent = expired ? 'La sesión de operador venció. Ingresá de nuevo.' : '';
  }
  function teardown() {
    S.closing = true; clearTimeout(S.reconnectTimer);
    if (S.ws) { try { S.ws.close(); } catch (e) { /* ya cerrado */ } S.ws = null; }
    S.session = null; S.masterToken = null; S.connected = false;
  }

  // ---------------------------------------------------------------- vistas
  function enter() {
    show('loginView', false); show('logout', true); flashLoad();
    var sid = null; try { sid = sessionStorage.getItem('ds-sid'); } catch (e) { /* bloqueado */ }
    if (sid) return resume(sid).catch(function () { showSetup(); });
    showSetup();
  }
  function showSetup() {
    teardown(); show('setupView', true); show('control', false); pill('status', '● sin sesión');
    api('GET', '/api/sessions').then(function (j) {
      var ul = $('sessionList'); ul.textContent = '';
      (j.sessions || []).forEach(function (s) {
        var li = document.createElement('li');
        var span = document.createElement('span'); span.textContent = s.id + '  ·  ' + new Date(s.createdAt).toLocaleString();
        var b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.textContent = 'Retomar';
        b.addEventListener('click', function () { resume(s.id).catch(function (e) { alertBox('bad', e.message, 'setup'); }); });
        li.appendChild(span); li.appendChild(b); ul.appendChild(li);
      });
      if (!(j.sessions || []).length) { var li = document.createElement('li'); li.textContent = 'No hay sesiones activas.'; li.style.fontFamily = 'inherit'; ul.appendChild(li); }
    }).catch(function () { /* logout ya mostrado */ });
  }
  function adopt(d) {
    S.closing = false;
    S.session = d.sessionId; S.masterToken = d.masterToken; S.strobeEnabled = !!d.strobeEnabled;
    try { sessionStorage.setItem('ds-sid', d.sessionId); } catch (e) { /* bloqueado */ }
    $('code').textContent = d.sessionId; $('url').textContent = d.joinUrl;
    var qr = $('qr'); qr.textContent = '';
    new QRCode(qr, { text: d.joinUrl, width: 420, height: 420, colorDark: '#111', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
    show('setupView', false); show('control', true); alertBox('', null, 'setup');
    paintStrobe(); connect();
  }
  function create() { return api('POST', '/api/sessions', {}).then(adopt); }
  function resume(id) { return api('POST', '/api/sessions/' + id + '/master-token', {}).then(adopt); }

  // ---------------------------------------------------------------- app Flash (acceso habilitable por el operador)
  // El interruptor vive en el servidor (/api/admin/flash). El código del QR Flash es solo una etiqueta para los teléfonos (la app Flash no usa el servidor).
  var FLASH_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var F = { enabled: false, url: '', code: null, loaded: false };
  function flashNewCode() {
    var a = new Uint8Array(6); (window.crypto || window.msCrypto).getRandomValues(a);
    var c = ''; for (var i = 0; i < 6; i++) c += FLASH_CHARS[a[i] % FLASH_CHARS.length];     // sesgo mínimo: irrelevante para una etiqueta pública
    F.code = c; try { sessionStorage.setItem('ds-flash-code', c); } catch (e) { /* bloqueado */ }
  }
  function flashLink() { return F.url + '?s=' + F.code; }
  function flashPaint() {
    show('flashCard', true);
    pill('flashState', F.enabled ? 'Flash: HABILITADA' : 'Flash: deshabilitada', F.enabled ? 'ok' : '');
    $('flashToggle').textContent = F.enabled ? 'Deshabilitar app Flash' : 'Habilitar app Flash';
    $('flashToggle').disabled = false;
    show('flashOn', F.enabled);
    if (!F.enabled) { $('flashQr').textContent = ''; return; }
    if (!F.code) { try { F.code = sessionStorage.getItem('ds-flash-code'); } catch (e) { F.code = null; } if (!/^[A-HJ-NP-Z2-9]{6}$/.test(F.code || '')) flashNewCode(); }
    var link = flashLink();
    $('flashCode').textContent = F.code; $('flashUrl').textContent = link;
    var qr = $('flashQr'); qr.textContent = '';
    new QRCode(qr, { text: link, width: 230, height: 230, colorDark: '#111', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
  }
  function flashApply(j) { F.enabled = !!j.enabled; F.url = j.url; F.loaded = true; flashPaint(); }
  function flashLoad() {
    return api('GET', '/api/admin/flash').then(flashApply).catch(function (e) {
      pill('flashState', 'Flash: sin datos', 'bad'); show('flashCard', true); alertBox('bad', 'No se pudo consultar el estado de la app Flash: ' + e.message, 'flash');
    });
  }
  function flashToggle() {
    $('flashToggle').disabled = true;
    return api('POST', '/api/admin/flash', { enabled: !F.enabled }).then(function (j) { alertBox('', null, 'flash'); flashApply(j); })
      .catch(function (e) { $('flashToggle').disabled = false; alertBox('bad', 'No se pudo cambiar la app Flash: ' + e.message, 'flash'); });
  }

  // ---------------------------------------------------------------- WebSocket del Master
  function wsUrl() { return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws'; }
  function connect() {
    if (S.closing || !S.session) return;
    if (S.ws) { try { S.ws.onclose = null; S.ws.close(); } catch (e) { /* ya cerrado */ } }
    pill('status', '● conectando', ''); $('hConn').textContent = 'conectando…';
    var ws = new WebSocket(wsUrl()); S.ws = ws;
    ws.onopen = function () { ws.send(JSON.stringify({ protocolVersion: PROTOCOL, type: 'hello', role: 'master', sessionId: S.session, token: S.masterToken })); };
    ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMessage(m); };
    ws.onclose = function (ev) {
      if (S.ws === ws) S.ws = null; S.connected = false; $('send').disabled = true;
      S.tracker.onDisconnect();
      if (S.closing) return;
      pill('status', '● sin conexión', 'bad'); $('hConn').textContent = 'sin conexión (' + ev.code + ')';
      if (ev.code === 4401) return resume(S.session).catch(function (e) { alertBox('bad', e.message, 'conn'); });          // token vencido o revocado: pedir uno nuevo
      if (ev.code === 4404) return recreate();                                                                              // la sesión se perdió (p. ej. reinicio sin Redis)
      reconnect(ev.code === 1012 ? 500 + Math.random() * 3000 : null);
    };
  }
  function recreate() {
    alertBox('warn', 'La sesión se perdió en el servidor (¿reinicio?). Recreándola con el mismo código para que los teléfonos la retomen…', 'conn');
    api('POST', '/api/sessions', { sessionId: S.session }).then(function (d) { adopt(d); alertBox('info', 'Sesión recuperada con el mismo código.', 'conn'); })
      .catch(function (e) { alertBox('bad', 'No se pudo recrear la sesión: ' + e.message, 'conn'); });
  }
  function reconnect(hint) {
    if (S.reconnectTimer) return;
    S.attempts++; var cap = Math.min(15000, 500 * Math.pow(2, Math.min(S.attempts, 5)));
    var d = hint == null ? Math.max(300, Math.random() * cap) : hint;
    S.reconnectTimer = setTimeout(function () { S.reconnectTimer = null; connect(); }, d);
  }
  function send(obj) { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(obj)); return true; } return false; }

  function onMessage(m) {
    switch (m.type) {
      case 'welcome':
        S.attempts = 0; S.connected = true; pill('status', '● online', 'ok'); $('hConn').textContent = 'conectado'; $('send').disabled = false;
        S.strobeEnabled = !!m.config.strobeEnabled; S.maxHz = m.config.maxStrobeHz || 3; $('maxHz').textContent = String(S.maxHz); $('hz').max = String(S.maxHz);
        $('count').textContent = String(m.connected || 0); showState(m.state); paintStrobe();
        S.latestVersion = m.state ? m.state.stateVersion : 0;
        resendAfterReconnect();
        break;
      case 'presence':
        $('count').textContent = String(m.connected); $('countDetail').textContent = 'En esta instancia: ' + m.localConnected;
        if (m.health) paintHealth(m.health);
        break;
      case 'ack': onAck(m); break;
      case 'state': if (m.stateVersion > S.latestVersion) S.latestVersion = m.stateVersion; showState(m); break;
      case 'stats': paintStats(m); break;
      case 'config': S.strobeEnabled = !!m.strobeEnabled; paintStrobe(); break;
      case 'error':
        S.tracker.reject(m.commandId);                                // solo el comando al que se refiere el error (si es uno nuestro)
        alertBox('bad', m.code + ': ' + m.message, 'cmd'); setTimeout(function () { alertBox('bad', null, 'cmd'); }, 6000); break;
      case 'restart': reconnect(Math.max(500, Math.min(8000, m.reconnectAfterMs || 2000))); break;
      default: break;
    }
  }
  // Un ACK solo confirma el comando con ESE commandId. Duplicados, desconocidos y tardíos se clasifican y no alteran el estado de la pantalla.
  function onAck(m) {
    var r = S.tracker.ack(m);
    if (r.kind === 'duplicate' || r.kind === 'unknown') return;
    if (r.kind === 'late') { alertBox('info', 'Llegó la confirmación tardía de una orden anterior (v' + m.stateVersion + '); la orden actual sigue pendiente.', 'ack'); setTimeout(function () { alertBox('info', null, 'ack'); }, 4000); return; }
    alertBox('warn', null, 'cmd');
    S.lastAccepted = m;
    var stale = m.duplicate && m.stateVersion < S.latestVersion;     // ya se había aplicado y hay un estado más nuevo: no tocar las estadísticas actuales
    $('kAccepted').textContent = 'ACEPTADA · v' + m.stateVersion + (m.duplicate ? ' (ya estaba aplicada: no se repite)' : '') + ' · ejecuta en ' + Math.max(0, Math.round(m.executeAt - m.serverTimestamp)) + ' ms';
    if (stale) return;
    $('kApplied').textContent = 'esperando confirmaciones…'; $('kOnTime').textContent = '—'; $('kDev').textContent = '—';
    S.lastStatsVersion = m.stateVersion;
  }
  function resendAfterReconnect() {
    var r = S.tracker.onReconnect();
    r.dropped.forEach(function (e) { alertBox('warn', 'Se descartó una orden que no llegó a confirmarse antes de la desconexión (ya era antigua o fue reemplazada por otra más nueva).', 'drop'); setTimeout(function () { alertBox('warn', null, 'drop'); }, 6000); });
    r.resend.forEach(function (e) { send(e.msg); $('kAccepted').textContent = 'REENVIANDO tras reconexión…'; });
  }
  // Vencimiento de ACK: se reenvía el MISMO commandId (el servidor es idempotente) y, agotados los intentos, se avisa.
  setInterval(function () {
    var d = S.tracker.due();
    d.resend.forEach(function (e) { if (S.connected) { send(e.msg); $('kAccepted').textContent = 'SIN CONFIRMACIÓN: reintento ' + (e.attempts - 1) + '…'; } else e.attempts--; });
    d.failed.forEach(function (e) { alertBox('bad', 'El servidor no confirmó la orden después de ' + e.attempts + ' intentos. Verificá la conexión y volvé a enviarla.', 'cmd'); });
  }, 500);

  function showState(st) {
    if (!st || !st.payload) return;
    $('kState').textContent = 'v' + st.stateVersion + ' · ' + st.payload.effect + (st.payload.effect === 'off' ? '' : ' · ' + st.payload.color);
  }
  function paintStats(m) {
    if (m.stateVersion !== S.lastStatsVersion) return;
    $('count').textContent = String(m.connected);
    if (!m.responded) { $('kApplied').textContent = 'sin confirmaciones todavía (se reporta una muestra de teléfonos)'; return; }
    $('kApplied').textContent = m.responded + ' dispositivos confirmaron (muestra)';
    $('kOnTime').textContent = m.onTimePct + '% dentro de ±' + m.toleranceMs + ' ms · ' + m.late + ' fuera de margen';
    $('kDev').textContent = 'p50 ' + m.deviationP50Ms + ' ms · p95 ' + m.deviationP95Ms + ' ms · p99 ' + m.deviationP99Ms + ' ms';
    var lateArrivalPct = m.responded ? (m.lateArrival * 100 / m.responded) : 0;
    if (m.responded >= 20 && (m.onTimePct < 90 || lateArrivalPct > 5)) {
      alertBox('warn', 'Las órdenes podrían estar llegando tarde (' + m.onTimePct + '% a tiempo, ' + Math.round(lateArrivalPct) + '% llegaron después de su ejecución). Elegí un margen mayor.', 'late');
    } else alertBox('warn', null, 'late');
  }
  function paintHealth(h) {
    var cls = h.status === 'ok' ? 'ok' : (h.status === 'degraded' ? '' : 'bad');
    pill('health', 'salud: ' + h.status, cls);
    $('hStatus').textContent = h.status + (h.reasons && h.reasons.length ? ' — ' + h.reasons.join('; ') : '');
    $('hLag').textContent = h.eventLoopLagP99Ms + ' ms (p99)';
    $('hStore').textContent = h.storeLatencyMs == null ? 'sin respuesta' : Math.round(h.storeLatencyMs * 10) / 10 + ' ms';
    if (h.status !== 'ok') alertBox(h.status === 'degraded' ? 'warn' : 'bad', 'Sistema ' + h.status + ': las órdenes podrían llegar tarde. ' + (h.reasons || []).join('; '), 'health');
    else alertBox('', null, 'health');
  }
  function paintStrobe() {
    show('strobeBox', S.effect === 'strobe' || S.strobeEnabled);
    $('strobeState').textContent = S.strobeEnabled ? 'Strobe HABILITADO en esta sesión (máx ' + S.maxHz + ' Hz, duración limitada).' : 'Strobe deshabilitado (valor seguro por defecto).';
    show('strobeEnable', !S.strobeEnabled); show('strobeDisable', S.strobeEnabled);
  }

  // ---------------------------------------------------------------- controles
  function setEffect(e) {
    S.effect = e;
    document.querySelectorAll('[data-effect]').forEach(function (b) { b.classList.toggle('primary', b.getAttribute('data-effect') === e); });
    show('pFade', e === 'solid' || e === 'fade'); show('pColor2', e === 'fade' || e === 'pulse' || e === 'strobe');
    show('pPeriod', e === 'pulse'); show('pHz', e === 'strobe'); show('pDur', e === 'pulse' || e === 'strobe'); paintStrobe();
  }
  function selectColor(c, btn) {
    S.color = c; $('custom').value = c.toLowerCase(); $('colorHex').textContent = c;
    document.querySelectorAll('.color').forEach(function (x) { x.classList.toggle('active', x === btn); });
  }
  PALETTE.forEach(function (c) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'color'; b.style.background = c; b.title = c; b.setAttribute('aria-label', c);
    b.addEventListener('click', function () { selectColor(c, b); }); $('colors').appendChild(b); if (c === S.color) b.classList.add('active');
  });
  $('custom').addEventListener('input', function (e) { var c = e.target.value.toUpperCase(); S.color = c; $('colorHex').textContent = c; document.querySelectorAll('.color').forEach(function (x) { x.classList.remove('active'); }); });
  document.querySelectorAll('[data-effect]').forEach(function (b) { b.addEventListener('click', function () { setEffect(b.getAttribute('data-effect')); }); });
  setEffect('solid');

  function sendCommand() {
    var p = { effect: S.effect, color: S.color };
    if (S.effect === 'solid' || S.effect === 'fade') p.fadeMs = Number($('fadeMs').value) || 0;
    if (S.effect === 'fade' || S.effect === 'pulse' || S.effect === 'strobe') p.color2 = $('color2').value.toUpperCase();
    if (S.effect === 'pulse') { p.periodMs = Number($('periodMs').value) || 2000; p.durationMs = Math.round((Number($('durationS').value) || 0) * 1000); }
    if (S.effect === 'strobe') { p.hz = Math.min(S.maxHz, Number($('hz').value) || 2); p.durationMs = Math.max(500, Math.round((Number($('durationS').value) || 10) * 1000)); }
    var msg = { protocolVersion: PROTOCOL, type: 'command', commandId: newId(), leadMs: Number($('lead').value) || 1500, payload: p };
    track(msg, 'command');
  }
  // Registra el comando (el anterior queda "superado") y lo envía; si no hay conexión queda en cola y se reenvía al reconectar si sigue siendo reciente.
  function track(msg, kind) {
    var online = Boolean(S.ws && S.ws.readyState === 1);
    S.tracker.add(msg, { kind: kind, sent: online });
    if (!online) { alertBox('bad', 'Sin conexión con el servidor: la orden se enviará al reconectar (si no pasan más de 15 s).', 'cmd'); return false; }
    send(msg); $('kAccepted').textContent = 'ENVIANDO…'; return true;
  }
  function emergencyStop() {
    var ok = track({ protocolVersion: PROTOCOL, type: 'stop', commandId: newId() }, 'stop');
    if (!ok) alertBox('bad', 'SIN CONEXIÓN: no se pudo enviar la parada. Se reintentará al reconectar.', 'cmd');
  }

  $('send').addEventListener('click', sendCommand);
  $('stop').addEventListener('click', emergencyStop);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.session) emergencyStop(); });
  $('riskAck').addEventListener('change', function () { $('strobeEnable').disabled = !$('riskAck').checked; });
  $('strobeEnable').addEventListener('click', function () { send({ protocolVersion: PROTOCOL, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: $('riskAck').checked }); });
  $('strobeDisable').addEventListener('click', function () { send({ protocolVersion: PROTOCOL, type: 'setConfig', strobeEnabled: false }); $('riskAck').checked = false; $('strobeEnable').disabled = true; });
  $('create').addEventListener('click', function () { create().catch(function (e) { alertBox('bad', e.message, 'setup'); }); });
  $('refresh').addEventListener('click', showSetup);
  $('copy').addEventListener('click', function () { if (navigator.clipboard) navigator.clipboard.writeText($('url').textContent); });
  $('open').addEventListener('click', function () { window.open($('url').textContent, '_blank', 'noopener'); });
  $('logout').addEventListener('click', function () { logout(false); });
  $('flashToggle').addEventListener('click', flashToggle);
  $('flashNewCode').addEventListener('click', function () { flashNewCode(); flashPaint(); });
  $('flashCopy').addEventListener('click', function () { if (navigator.clipboard) navigator.clipboard.writeText($('flashUrl').textContent); });
  $('flashOpen').addEventListener('click', function () { window.open($('flashUrl').textContent, '_blank', 'noopener'); });
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault(); $('loginError').textContent = '';
    api('POST', '/api/master/login', { password: $('password').value }).then(function (j) {
      S.op = { token: j.operatorToken, expiresAt: j.expiresAt }; $('password').value = '';
      try { sessionStorage.setItem('ds-op', JSON.stringify(S.op)); } catch (e2) { /* bloqueado */ }
      enter();
    }).catch(function (err) { $('loginError').textContent = err.message; });
  });
  // Mientras hay sesión, el estado de salud también se consulta periódicamente por si el WebSocket está caído.
  setInterval(function () {
    if (!S.op || S.connected || !S.session) return;
    api('GET', '/api/admin/status').then(function (j) { paintHealth(j.health); }).catch(function () { /* ignorado */ });
  }, 10000);

  // Gancho para pruebas de navegador (solo lectura del estado interno).
  window.DestelloMaster = { tracker: S.tracker, state: S };

  if (S.op) enter();
})();
