/* Destello·Sync — motor de efectos (función pura del tiempo del servidor).
 *
 * Todos los teléfonos evalúan el MISMO estado con el MISMO instante de servidor, así que muestran el mismo color
 * sin depender de animaciones CSS que arrancan en momentos distintos en cada dispositivo.
 * Seguridad visual: el strobe nunca supera MAX_STROBE_HZ, siempre termina (durationMs) y con "reducir movimiento"
 * o conexión perdida los efectos animados se muestran como color fijo.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DestelloEffects = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX_STROBE_HZ = 3;
  var MAX_STROBE_MS = 30000;      // defensa en profundidad: aunque el servidor ya lo valida, el cliente NUNCA deja un strobe más de 30 s ni a más de 3 Hz

  function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mix(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
  function ease(k) { return k * k * (3 - 2 * k); }
  function css(rgb) { return 'rgb(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ')'; }

  /**
   * @param st   estado del servidor {executeAt, payload:{effect,color,color2,intensity,fadeMs,periodMs,hz,duty,durationMs}}
   * @param now  instante actual en tiempo de SERVIDOR (ms)
   * @param ctx  {from:[r,g,b] color mostrado cuando se aplicó el estado, reduced:boolean, stale:boolean}
   * @returns    {rgb:[r,g,b], animated:boolean, flashing:boolean}
   */
  function evaluate(st, now, ctx) {
    ctx = ctx || {};
    var p = st.payload;
    var t = Math.max(0, now - st.executeAt);
    var dim = p.intensity == null ? 1 : p.intensity;
    var calm = ctx.reduced || ctx.stale;
    var ended = p.durationMs > 0 && t >= p.durationMs;
    var rgb; var animated = false; var flashing = false;
    switch (p.effect) {
      case 'solid': {
        var target = hex(p.color); var fade = p.fadeMs || 0;
        var k = fade > 0 ? clamp(t / fade, 0, 1) : 1;
        rgb = ctx.from ? mix(ctx.from, target, ease(k)) : target; animated = k < 1;
        break;
      }
      case 'fade': {
        var a = hex(p.color); var b = hex(p.color2 || '#000000'); var f = p.fadeMs || 1500;
        var kf = clamp(t / f, 0, 1);
        rgb = mix(a, b, ease(kf)); animated = kf < 1;
        break;
      }
      case 'pulse': {
        if (ended || calm) { rgb = hex(p.color); break; }
        var period = Math.max(600, p.periodMs || 2000);
        var kp = 0.5 + 0.5 * Math.cos(2 * Math.PI * ((t % period) / period));
        rgb = mix(hex(p.color2 || '#000000'), hex(p.color), kp); animated = true;
        break;
      }
      case 'sequence': {
        // Secuencia de colores: cada paso se muestra holdMs; tras el último vuelve al primero (ininterrumpida si durationMs = 0). Todos los teléfonos
        // evalúan el mismo tiempo de servidor, así que cambian de color a la vez. fadeMs > 0 hace un fundido al entrar en cada paso (0 = corte seco).
        var steps = p.steps || []; var n = steps.length;
        if (!n) { rgb = [0, 0, 0]; break; }
        var total = 0, minHold = 1e12;
        for (var si = 0; si < n; si++) { total += steps[si].holdMs; if (steps[si].holdMs < minHold) minHold = steps[si].holdMs; }
        var flashLike = minHold < 1000;                                         // pasos < 1 s equivalen a parpadeo: respetan «reducir movimiento» del sistema
        if (ctx.manualOff || ctx.stale || (ctx.systemReduced && flashLike)) { rgb = hex(steps[0].color); break; }
        var endedSeq = p.durationMs > 0 && t >= p.durationMs;
        var tt = endedSeq ? p.durationMs : t;                                   // al terminar queda en el color del paso activo en ese instante
        var pos = tt % total, acc = 0, idx = 0;
        for (var sj = 0; sj < n; sj++) { idx = sj; if (pos < acc + steps[sj].holdMs) break; acc += steps[sj].holdMs; }
        var off = pos - acc; var cur = hex(steps[idx].color); var fdm = p.fadeMs || 0;
        if (fdm > 0 && off < fdm && !endedSeq) {
          var prevC = (idx === 0 && tt < steps[0].holdMs) ? (ctx.from || hex(steps[n - 1].color)) : hex(steps[(idx + n - 1) % n].color);
          rgb = mix(prevC, cur, ease(off / fdm));
        } else rgb = cur;
        animated = !endedSeq; flashing = flashLike && !endedSeq;
        break;
      }
      case 'strobe': {
        var sdur = p.durationMs > 0 ? Math.min(p.durationMs, MAX_STROBE_MS) : MAX_STROBE_MS;   // sin duración (o desmedida) => tope de 30 s
        if (t >= sdur || calm) { rgb = hex(p.color); break; }
        var hz = clamp(Number(p.hz) || 2, 0.5, MAX_STROBE_HZ); var per = 1000 / hz;
        var on = ((t % per) / per) < clamp(Number(p.duty) || 0.25, 0.1, 0.5);
        rgb = on ? hex(p.color) : hex(p.color2 || '#000000'); animated = true; flashing = true;
        break;
      }
      default: rgb = [0, 0, 0];     // 'off' o desconocido -> estado seguro (pantalla apagada)
    }
    return { rgb: [rgb[0] * dim, rgb[1] * dim, rgb[2] * dim], animated: animated, flashing: flashing };
  }

  var COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  var EFFECTS = { off: 1, solid: 1, fade: 1, pulse: 1, strobe: 1, sequence: 1 };
  /** Validación del payload RECIBIDO (el cliente no confía ciegamente en el servidor): un mensaje malformado se ignora en vez de romper el render. */
  function validPayload(p) {
    if (!p || typeof p !== 'object' || !EFFECTS[p.effect]) return false;
    if (p.effect !== 'off' && !COLOR_RE.test(p.color || '')) return false;
    if (p.color2 !== undefined && !COLOR_RE.test(p.color2)) return false;
    var nums = ['intensity', 'fadeMs', 'periodMs', 'hz', 'duty', 'durationMs'];
    for (var i = 0; i < nums.length; i++) { var v = p[nums[i]]; if (v !== undefined && (typeof v !== 'number' || !isFinite(v))) return false; }
    if (p.effect === 'sequence') {
      if (!Array.isArray(p.steps) || p.steps.length < 2 || p.steps.length > 12) return false;
      for (var k = 0; k < p.steps.length; k++) { var st = p.steps[k]; if (!st || !COLOR_RE.test(st.color || '') || typeof st.holdMs !== 'number' || !isFinite(st.holdMs) || st.holdMs < 100) return false; }
    }
    return true;
  }

  return { evaluate: evaluate, css: css, hex: hex, validPayload: validPayload, MAX_STROBE_HZ: MAX_STROBE_HZ };
});
