/* Destello·Sync V4.0 — sección «Eventos» del panel del operador. Se carga ANTES de master.js y se engancha por window.DestelloMasterHooks.
 * Todo texto dinámico se muestra con textContent (nunca innerHTML). El token de operador solo lo usa H.api (master.js); aquí nunca se lee.
 * Cada evento es independiente: su QR (/e/CÓDIGO), su configuración, su sesión y su operación. Al operar uno, el panel muestra su nombre de forma permanente.
 */
(function () {
  'use strict';
  var H = window.DestelloMasterHooks = window.DestelloMasterHooks || {};
  var $ = function (id) { return document.getElementById(id); };
  var api = function () { return H.api.apply(null, arguments); };
  var EFFECTS = [['solid', 'Fijo'], ['fade', 'Transición'], ['pulse', 'Pulso'], ['strobe', 'Strobe'], ['sequence', 'Secuencia']];
  var STATUS_LABEL = { draft: 'Borrador', scheduled: 'Programado', active: 'Activo', finished: 'Finalizado', cancelled: 'Cancelado' };
  var E = { list: [], dash: null, sel: null, archived: false, dashTimer: null, statsTimer: null, colors: [], stopText: null };

  function mk(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function fmt(ms) { return ms ? new Date(ms).toLocaleString() : 'sin fecha'; }
  function toLocalInput(ms) { if (!ms) return ''; var d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); }
  function fromLocalInput(v) { return v ? new Date(v).getTime() : null; }
  function pillClass(status) { return 'pill' + (status === 'active' ? ' ok' : (status === 'cancelled' ? ' bad' : '')); }
  function note(kind, text, key) { if (H.alert) H.alert(kind, text, key || 'events'); }
  function fail(e) { note('bad', e && e.message ? e.message : String(e), 'events'); }

  // ---------------------------------------------------------------- panel general y lista
  function loadAll() {
    return Promise.all([api('GET', '/api/events' + (E.archived ? '?archived=1' : '')), api('GET', '/api/events/dashboard')]).then(function (r) {
      E.list = r[0].events || []; E.dash = r[1]; note('', null, 'events'); renderDash(); renderList();
      if (E.sel) { var cur = E.list.filter(function (x) { return x.id === E.sel.id; })[0]; if (cur && cur.rev !== E.sel.rev && !E.dirty) openDetail(cur.id); }
    }).catch(fail);
  }
  function renderDash() {
    var d = E.dash; if (!d) return;
    $('dTotal').textContent = String(d.events.total); $('dActive').textContent = String(d.events.active); $('dConnected').textContent = String(d.connectedTotal);
    $('dInstances').textContent = String(d.infrastructure.instances);
    var st = d.infrastructure.store; $('dStore').textContent = (st.kind === 'redis' ? 'Redis ' : 'Memoria ') + (st.ok ? 'OK' + (st.latencyMs != null ? ' · ' + Math.round(st.latencyMs * 10) / 10 + ' ms' : '') : 'SIN RESPUESTA');
    $('dStore').className = 'num sm ' + (st.ok ? 'st-ok' : 'st-bad');
    var h = d.infrastructure.health; $('dHealth').textContent = h.status; $('dHealth').className = 'num sm ' + (h.status === 'ok' ? 'st-ok' : (h.status === 'degraded' ? 'st-warn' : 'st-bad'));
    var ul = $('dAlerts'); ul.textContent = '';
    d.alerts.forEach(function (a) { var li = mk('li', a.level === 'bad' ? 'st-bad' : 'st-warn', (a.level === 'bad' ? '⛔ ' : '⚠ ') + a.text); li.style.fontFamily = 'inherit'; ul.appendChild(li); });
  }
  function renderList() {
    var ul = $('evList'); ul.textContent = '';
    var conn = {}; if (E.dash) E.dash.perEvent.forEach(function (p) { conn[p.id] = p.connected; });
    var problems = E.dash ? E.dash.problemEvents : [];
    if (!E.list.length) { var empty = mk('li', 'muted', E.archived ? 'No hay eventos.' : 'Todavía no hay eventos. Creá el primero con «＋ Nuevo evento».'); ul.appendChild(empty); return; }
    E.list.forEach(function (ev) {
      var li = mk('li', 'evrow'); li.setAttribute('data-od-id', 'event-row-' + ev.id);
      var nm = mk('div', 'nm', ev.name + (ev.archived ? ' (archivado)' : '')); li.appendChild(nm);
      li.appendChild(mk('span', pillClass(ev.status), STATUS_LABEL[ev.status]));
      li.appendChild(mk('span', 'meta', fmt(ev.startsAt)));
      li.appendChild(mk('span', 'meta', 'Código ' + ev.code));
      if (ev.status === 'active') li.appendChild(mk('span', 'meta', (conn[ev.id] == null ? '—' : conn[ev.id]) + ' conectados'));
      if (problems.indexOf(ev.id) >= 0) li.appendChild(mk('span', 'pill bad', '⚠ revisar'));
      var b = mk('button', 'btn', 'Abrir'); b.type = 'button'; b.addEventListener('click', function () { openDetail(ev.id); }); li.appendChild(b);
      ul.appendChild(li);
    });
  }

  // ---------------------------------------------------------------- detalle de un evento
  function colorRow(c) {
    var w = mk('span', 'colorrow'); var i = mk('input'); i.type = 'color'; i.value = c.toLowerCase(); i.setAttribute('aria-label', 'Color del evento');
    var x = mk('button', 'btn', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Quitar color');
    x.addEventListener('click', function () { if ($('fColors').children.length > 1) { w.remove(); E.dirty = true; } });
    i.addEventListener('input', function () { E.dirty = true; });
    w.appendChild(i); w.appendChild(x); return w;
  }
  function seqToText(seqs) {
    return seqs.map(function (s) { return s.name + ': ' + s.steps.map(function (st) { return st.color + ' ' + (st.holdMs / 1000); }).join(', ') + (s.fadeMs ? ' | transición ' + s.fadeMs + ' ms' : ''); }).join('\n');
  }
  function textToSeq(text) {
    var out = [];
    text.split('\n').forEach(function (raw, ln) {
      var line = raw.trim(); if (!line) return;
      var m = /^([^:]{1,40}):\s*(.+)$/.exec(line); if (!m) throw new Error('Secuencia, línea ' + (ln + 1) + ': usá «Nombre: #FF0000 3, #0000FF 3»');
      var fade = 0, body = m[2]; var fm = /\|\s*transición\s+(\d+)\s*ms\s*$/i.exec(body); if (fm) { fade = Number(fm[1]); body = body.slice(0, fm.index); }
      var steps = body.split(',').map(function (p) {
        var q = /^\s*(#[0-9A-Fa-f]{6})\s+([0-9]+(?:[.,][0-9]+)?)\s*$/.exec(p); if (!q) throw new Error('Secuencia, línea ' + (ln + 1) + ': paso inválido «' + p.trim() + '»');
        return { color: q[1].toUpperCase(), holdMs: Math.round(Number(q[2].replace(',', '.')) * 1000) };
      });
      out.push({ name: m[1].trim(), steps: steps, fadeMs: fade, durationMs: 0 });
    });
    return out;
  }
  function readForm() {
    var colors = Array.prototype.map.call($('fColors').querySelectorAll('input[type=color]'), function (i) { return i.value.toUpperCase(); });
    var effects = Array.prototype.filter.call($('fEffects').querySelectorAll('input'), function (i) { return i.checked; }).map(function (i) { return i.value; });
    var lead = $('fLead').value === '' ? null : Number($('fLead').value);
    return { name: $('fName').value, description: $('fDesc').value, startsAt: fromLocalInput($('fStarts').value), config: { colors: colors, sequences: textToSeq($('fSeq').value), effectsAllowed: effects, leadMs: lead } };
  }
  function openDetail(id) {
    return api('GET', '/api/events/' + id).then(function (r) { E.sel = r.event; E.dirty = false; paintDetail(); startStats(); }).catch(fail);
  }
  function paintDetail() {
    var ev = E.sel; if (!ev) return;
    H.show('evDetail', true);
    $('evName').textContent = ev.name; $('evStatus').textContent = STATUS_LABEL[ev.status] + (ev.archived ? ' · archivado' : ''); $('evStatus').className = pillClass(ev.status);
    $('fName').value = ev.name; $('fDesc').value = ev.description || ''; $('fStarts').value = toLocalInput(ev.startsAt);
    var cw = $('fColors'); cw.textContent = ''; ev.config.colors.forEach(function (c) { cw.appendChild(colorRow(c)); });
    $('fSeq').value = seqToText(ev.config.sequences);
    var ef = $('fEffects'); ef.textContent = '';
    EFFECTS.forEach(function (e) {
      var l = mk('label'); l.style.flexDirection = 'row'; l.style.alignItems = 'center'; l.style.gap = '6px';
      var i = mk('input'); i.type = 'checkbox'; i.value = e[0]; i.checked = ev.config.effectsAllowed.indexOf(e[0]) >= 0; i.addEventListener('change', function () { E.dirty = true; });
      l.appendChild(i); l.appendChild(document.createTextNode(e[1] + (e[0] === 'strobe' ? ' (requiere STROBE_ALLOWED en el servidor)' : ''))); ef.appendChild(l);
    });
    $('fLead').value = ev.config.leadMs == null ? '' : String(ev.config.leadMs);
    var locked = ev.archived || ev.status === 'finished'; ['fName', 'fDesc', 'fStarts', 'fSeq', 'fLead', 'fSave', 'fAddColor'].forEach(function (k) { $(k).disabled = locked; });
    $('fMsg').textContent = locked ? 'Este evento no se puede editar (' + (ev.archived ? 'archivado' : 'finalizado') + ').' : '';
    $('evCode').textContent = ev.code; $('evUrl').textContent = ev.url;
    var qr = $('evQr'); qr.textContent = ''; new QRCode(qr, { text: ev.url, width: 420, height: 420, colorDark: '#111', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
    paintActions(); loadAudit(); pollStats();
  }
  function paintActions() {
    var ev = E.sel, box = $('evActions'); box.textContent = '';
    function btn(label, cls, fn) { var b = mk('button', 'btn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); box.appendChild(b); return b; }
    if (!ev.archived) {
      if (ev.status === 'draft') { btn('Activar', 'primary', function () { changeStatus('active'); }); btn('Programar', '', function () { changeStatus('scheduled'); }); btn('Cancelar evento', 'danger', function () { changeStatus('cancelled'); }); }
      if (ev.status === 'scheduled') { btn('Activar', 'primary', function () { changeStatus('active'); }); btn('Volver a borrador', '', function () { changeStatus('draft'); }); btn('Cancelar evento', 'danger', function () { changeStatus('cancelled'); }); }
      if (ev.status === 'active') { btn('Operar este evento', 'primary', function () { operate(ev.id).catch(fail); }); btn('Desactivar', '', function () { changeStatus('scheduled'); }); btn('Finalizar', 'danger', function () { changeStatus('finished'); }); btn('Cancelar evento', 'danger', function () { changeStatus('cancelled'); }); }
      if (ev.status === 'cancelled') btn('Reabrir como borrador', '', function () { changeStatus('draft'); });
      btn('Duplicar', '', duplicate);
      if (ev.status !== 'active') btn('Archivar', 'danger', archive);
    } else btn('Restaurar', '', restore);
  }
  var VERB = { active: 'ACTIVAR', scheduled: 'DESACTIVAR (volver a «programado»)', finished: 'FINALIZAR', cancelled: 'CANCELAR', draft: 'volver a borrador' };
  var EFFECT_OF = {
    active: 'Los teléfonos que escaneen su QR podrán entrar.',
    scheduled: 'Se cerrarán las conexiones de los participantes (pueden reconectar al reactivarlo).',
    finished: 'Se cerrarán las conexiones y el evento no podrá reactivarse.',
    cancelled: 'Se cerrarán las conexiones de los participantes.', draft: ''
  };
  function changeStatus(status) {
    var ev = E.sel;
    // Antes de cada acción crítica se muestra el NOMBRE del evento seleccionado.
    if (status !== 'draft' && !window.confirm('Evento: «' + ev.name + '» (código ' + ev.code + ')\n\n¿' + VERB[status] + '?\n' + EFFECT_OF[status])) return;
    api('POST', '/api/events/' + ev.id + '/status', { status: status }).then(function (r) { E.sel = r.event; E.dirty = false; paintDetail(); loadAll(); }).catch(fail);
  }
  function duplicate() {
    api('POST', '/api/events/' + E.sel.id + '/duplicate', {}).then(function (r) { note('info', 'Evento duplicado: «' + r.event.name + '» (borrador, QR nuevo).', 'events'); return loadAll().then(function () { return openDetail(r.event.id); }); }).catch(fail);
  }
  function archive() {
    var ev = E.sel;
    var code = window.prompt('Vas a ARCHIVAR el evento «' + ev.name + '».\nSe conserva su registro y estadísticas, pero deja de aparecer y su QR deja de funcionar.\n\nEscribí su código (' + ev.code + ') para confirmar:');
    if (code == null) return;
    api('POST', '/api/events/' + ev.id + '/archive', { confirm: code.trim().toUpperCase() }).then(function (r) { E.sel = r.event; paintDetail(); loadAll(); }).catch(fail);
  }
  function restore() { api('POST', '/api/events/' + E.sel.id + '/restore', {}).then(function (r) { E.sel = r.event; paintDetail(); loadAll(); }).catch(fail); }
  function save() {
    var body; try { body = readForm(); } catch (e) { $('fMsg').textContent = e.message; $('fMsg').className = 'small st-bad'; return; }
    body.rev = E.sel.rev;
    api('POST', '/api/events/' + E.sel.id + '/update', body).then(function (r) { E.sel = r.event; E.dirty = false; paintDetail(); $('fMsg').textContent = 'Guardado.'; $('fMsg').className = 'small st-ok'; loadAll(); })
      .catch(function (e) { $('fMsg').textContent = e.message; $('fMsg').className = 'small st-bad'; });
  }
  function newEvent() {
    var name = window.prompt('Nombre del nuevo evento:'); if (!name || !name.trim()) return;
    api('POST', '/api/events', { name: name.trim() }).then(function (r) { return loadAll().then(function () { return openDetail(r.event.id); }); }).catch(fail);
  }

  // ---------------------------------------------------------------- estadísticas y registro
  function pollStats() {
    if (!E.sel) return;
    api('GET', '/api/events/' + E.sel.id + '/stats').then(function (s) {
      $('sConn').textContent = String(s.connected); $('sPeak').textContent = String(s.peakConnected);
      $('sLast').textContent = s.lastOrder ? 'v' + s.lastOrder.stateVersion + ' · ' + s.lastOrder.effect + (s.lastOrder.color ? ' · ' + s.lastOrder.color : '') + ' · ' + new Date(s.lastOrder.serverTimestamp).toLocaleTimeString() : '—';
      var d = s.delivery || {};
      $('sOnTime').textContent = d.responded ? d.onTimePct + '% (' + d.responded + ' respondieron)' : '—';
      $('sDev').textContent = d.responded ? 'p50 ' + d.deviationP50Ms + ' ms · p95 ' + d.deviationP95Ms + ' ms' : '—';
    }).catch(function () { /* se reintenta */ });
  }
  function startStats() { clearInterval(E.statsTimer); E.statsTimer = setInterval(function () { if (E.sel && !document.hidden) pollStats(); }, 3000); }
  function loadAudit() {
    api('GET', '/api/events/' + E.sel.id + '/audit?limit=30').then(function (r) {
      var ul = $('evAudit'); ul.textContent = '';
      r.audit.forEach(function (a) { var li = mk('li', null, new Date(a.at).toLocaleString() + ' · ' + a.action + (a.detail ? ' · ' + a.detail : '') + ' · ' + a.actor); li.style.fontFamily = 'inherit'; ul.appendChild(li); });
    }).catch(function () { /* secundario */ });
  }

  // ---------------------------------------------------------------- QR: enlace, vista ampliada, PNG y SVG
  function download(name, href) { var a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function qrCanvasPng(text, size) {
    var tmp = document.createElement('div'); new QRCode(tmp, { text: text, width: size, height: size, colorDark: '#111111', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    var c = tmp.querySelector('canvas'); return c ? c.toDataURL('image/png') : null;
  }
  function qrSvg(text) {
    var tmp = document.createElement('div'); var q = new QRCode(tmp, { text: text, width: 64, height: 64, correctLevel: QRCode.CorrectLevel.M });
    var m = q._oQRCode; if (!m || !m.getModuleCount) return null;
    var n = m.getModuleCount(), quiet = 4, size = n + quiet * 2, d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (m.isDark(r, c)) d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="1024" height="1024" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#111"/></svg>';
  }
  function fileSafe(s) { return s.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'evento'; }
  function dlPng() { var ev = E.sel, url = qrCanvasPng(ev.url, 1024); if (!url) return note('bad', 'Este navegador no pudo generar el PNG.', 'events'); download('qr-' + fileSafe(ev.name) + '-' + ev.code + '.png', url); }
  function dlSvg() {
    var ev = E.sel, svg = qrSvg(ev.url); if (!svg) return note('bad', 'Este navegador no pudo generar el SVG.', 'events');
    var u = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); download('qr-' + fileSafe(ev.name) + '-' + ev.code + '.svg', u); setTimeout(function () { URL.revokeObjectURL(u); }, 5000);
  }
  function bigQr() {
    var ev = E.sel; $('qrBigName').textContent = ev.name; $('qrBigCode').textContent = ev.code;
    var box = $('qrBigImg'); box.textContent = ''; new QRCode(box, { text: ev.url, width: 560, height: 560, colorDark: '#111', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
    H.show('qrBig', true);
  }

  // ---------------------------------------------------------------- operar un evento (reutiliza el control existente, aislado por sesión/token del evento)
  function operate(id) {
    return api('POST', '/api/events/' + id + '/master-token', {}).then(function (d) { H.adopt(d); });
  }
  H.operate = operate;
  H.onSetup = function (on) {
    H.show('eventsView', on);
    clearInterval(E.dashTimer);
    if (on) { applyEvent(null); loadAll(); E.dashTimer = setInterval(function () { if (!document.hidden) loadAll(); }, 5000); }
    else { clearInterval(E.statsTimer); }
  };
  // Al operar un evento: nombre siempre visible, paleta y secuencias del evento, y solo los efectos que el evento permite.
  function applyEvent(ev) {
    if (E.stopText == null) E.stopText = $('stop').textContent;
    H.show('eventBanner', Boolean(ev));
    if (H.setPalette) H.setPalette(ev ? ev.config.colors : null);
    var presets = $('seqPresets'); presets.textContent = ''; H.show('seqPresets', Boolean(ev && ev.config.sequences.length));
    if (ev) {
      $('ebName').textContent = ev.name; $('ebCode').textContent = 'Código ' + ev.code;
      $('stop').textContent = '■ DETENER «' + ev.name + '» (volver a pantalla apagada) — tecla Esc';
      ev.config.sequences.forEach(function (s) { var b = mk('button', 'btn', '▶ ' + s.name); b.type = 'button'; b.title = 'Cargar esta secuencia'; b.addEventListener('click', function () { H.setSteps(s.steps, s.fadeMs); }); presets.appendChild(b); });
    } else $('stop').textContent = E.stopText;
    var allowed = ev ? ev.config.effectsAllowed : null;
    Array.prototype.forEach.call(document.querySelectorAll('[data-effect]'), function (b) { b.classList.toggle('hidden', Boolean(allowed) && allowed.indexOf(b.getAttribute('data-effect')) < 0); });
    if (allowed && allowed.indexOf(H.getEffect()) < 0) H.setEffect(allowed[0]);
  }
  H.onEnter = applyEvent;
  H.onEventEnded = function (ev, code) {
    H.teardown(); H.show('control', false); H.showSetup();
    note('bad', 'El evento «' + ev.name + '» ' + (code === 4410 ? 'terminó' : 'se desactivó') + ': se cerró la conexión de control.', 'events');
  };

  // ---------------------------------------------------------------- eventos de la interfaz
  $('evRefresh').addEventListener('click', loadAll);
  $('evNew').addEventListener('click', newEvent);
  $('evArchived').addEventListener('change', function () { E.archived = $('evArchived').checked; loadAll(); });
  $('evClose').addEventListener('click', function () { E.sel = null; clearInterval(E.statsTimer); H.show('evDetail', false); });
  $('fSave').addEventListener('click', save);
  $('fAddColor').addEventListener('click', function () { if ($('fColors').children.length < 12) { $('fColors').appendChild(colorRow('#FFFFFF')); E.dirty = true; } });
  ['fName', 'fDesc', 'fStarts', 'fSeq', 'fLead'].forEach(function (k) { $(k).addEventListener('input', function () { E.dirty = true; }); });
  $('evCopy').addEventListener('click', function () { if (navigator.clipboard) navigator.clipboard.writeText(E.sel.url).then(function () { note('info', 'Enlace copiado: ' + E.sel.url, 'events'); setTimeout(function () { note('', null, 'events'); }, 3000); }); });
  $('evBig').addEventListener('click', bigQr); $('evPng').addEventListener('click', dlPng); $('evSvg').addEventListener('click', dlSvg);
  $('qrBigClose').addEventListener('click', function () { H.show('qrBig', false); });
  $('ebBack').addEventListener('click', function () { H.teardown(); H.show('control', false); H.showSetup(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('qrBig').classList.contains('hidden')) { e.stopPropagation(); H.show('qrBig', false); } }, true);
})();
