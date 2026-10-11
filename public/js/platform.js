/* Destello·Sync — detección de plataforma y pantalla completa (módulo sin dependencias, testeable con objetos simulados).
 *
 * LO QUE UNA PÁGINA WEB PUEDE Y NO PUEDE CONTROLAR (resumen; detalle en docs/COBERTURA_PANTALLA.md):
 *  - Android/Chrome: Fullscreen API estándar; requiere un gesto del usuario. Oculta barra de estado y de navegación del navegador.
 *  - iPhone/Safari: NO existe Fullscreen API para elementos de una página (solo vídeo). La barra de Safari se oculta con "aA → Ocultar barra de
 *    herramientas" o instalando la página en la pantalla de inicio (modo independiente); la barra de estado del sistema (hora/batería) y el
 *    indicador de inicio SIEMPRE son del sistema operativo.
 *  - iPad/Safari: sí admite webkitRequestFullscreen en elementos.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DestelloPlatform = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

  function mm(win, q) { try { return Boolean(win.matchMedia && win.matchMedia(q).matches); } catch (e) { return false; } }

  /** Entorno del navegador: sistema, modo de visualización y si es la página instalada. */
  function detect(nav, win) {
    nav = nav || (typeof navigator !== 'undefined' ? navigator : {}); win = win || (typeof window !== 'undefined' ? window : {});
    var ua = String(nav.userAgent || '');
    var iphone = /iPhone|iPod/.test(ua);
    var ipad = /iPad/.test(ua) || (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1);   // iPadOS se identifica como Mac
    var ios = iphone || ipad;
    var android = /Android/i.test(ua);
    var displayMode = 'browser';
    if (mm(win, '(display-mode: fullscreen)')) displayMode = 'fullscreen';
    else if (nav.standalone === true || mm(win, '(display-mode: standalone)')) displayMode = 'standalone';
    else if (mm(win, '(display-mode: minimal-ui)')) displayMode = 'minimal-ui';
    return { ios: ios, iphone: iphone, ipad: ipad, android: android, displayMode: displayMode, installed: displayMode !== 'browser',
      safari: ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) };
  }

  /** 'standard' | 'webkit' | 'ms' | 'none' según lo que ofrece el documento. */
  function fullscreenApi(doc) {
    var e = doc && doc.documentElement; if (!e) return 'none';
    if (typeof e.requestFullscreen === 'function') return 'standard';
    if (typeof e.webkitRequestFullscreen === 'function') return 'webkit';
    if (typeof e.msRequestFullscreen === 'function') return 'ms';
    return 'none';
  }
  function isFullscreen(doc) { return Boolean(doc && (doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement)); }

  /**
   * Solicita pantalla completa para el documento. NUNCA lanza: siempre resuelve {ok, api, reason}.
   * Maneja las tres formas reales: promesa que se resuelve (Chrome/Android), promesa rechazada (sin gesto, política del navegador, iframe),
   * llamada síncrona sin promesa (WebKit antiguo) y ausencia total de la API (iPhone/Safari).
   */
  function requestFullscreen(doc) {
    return new Promise(function (resolve) {
      var api = fullscreenApi(doc);
      if (api === 'none') return resolve({ ok: false, api: api, reason: 'unsupported' });
      var e = doc.documentElement;
      try {
        var p = api === 'standard' ? e.requestFullscreen({ navigationUI: 'hide' }) : (api === 'webkit' ? e.webkitRequestFullscreen() : e.msRequestFullscreen());
        if (p && typeof p.then === 'function') p.then(function () { resolve({ ok: true, api: api }); }, function (err) { resolve({ ok: false, api: api, reason: (err && err.name) || 'rejected' }); });
        else resolve({ ok: true, api: api, sync: true });
      } catch (err) { resolve({ ok: false, api: api, reason: (err && err.name) || 'exception' }); }
    });
  }
  function exitFullscreen(doc) {
    try { var f = doc.exitFullscreen || doc.webkitExitFullscreen || doc.msExitFullscreen; if (f && isFullscreen(doc)) { var p = f.call(doc); if (p && p.catch) p.catch(function () { /* ya salió */ }); } } catch (e) { /* ignorado */ }
  }

  /** Código de sesión válido (6 caracteres del alfabeto sin I/O/0/1/L) o null. */
  function normalizeCode(raw) { var c = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return CODE_RE.test(c) ? c : null; }

  function toHex(rgb) {
    var h = function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); };
    return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]);
  }

  /**
   * Consejo para el participante según lo que ESTE navegador permite realmente. Devuelve {key, text}.
   * (No promete ocultar nada que el sistema operativo no deje ocultar.)
   */
  function advice(env, fsApi) {
    if (env.installed) return { key: 'installed', text: 'Listo: estás usando la versión instalada. Subí el brillo al máximo y mantené la pantalla encendida.' };
    if (env.iphone) return { key: 'ios-iphone', text: 'En iPhone, Safari no permite ocultar su barra desde una web. Para la mejor cobertura: tocá Compartir → «Agregar a pantalla de inicio» y abrí Destello desde el ícono; o tocá «aA» → «Ocultar barra de herramientas». La barra de estado (hora y batería) siempre la controla iOS.' };
    if (env.ios) return { key: 'ios-ipad', text: 'Tocá la pantalla para pantalla completa. Si tu navegador no la permite, usá Compartir → «Agregar a pantalla de inicio».' };
    if (fsApi === 'none') return { key: 'no-fullscreen', text: 'Este navegador no ofrece pantalla completa. Subí el brillo al máximo; si podés, instalá la página desde el menú del navegador.' };
    return { key: 'fullscreen', text: 'Tocá la pantalla una vez para activar la pantalla completa y subí el brillo al máximo.' };
  }

  return { detect: detect, fullscreenApi: fullscreenApi, isFullscreen: isFullscreen, requestFullscreen: requestFullscreen, exitFullscreen: exitFullscreen,
    normalizeCode: normalizeCode, toHex: toHex, advice: advice, CODE_RE: CODE_RE };
});
