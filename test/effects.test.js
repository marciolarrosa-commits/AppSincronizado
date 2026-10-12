'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FX = require('../public/js/effects');

const st = (payload, executeAt = 1000) => ({ executeAt, payload: { intensity: 1, color2: '#000000', ...payload } });
const ev = (s, now, ctx) => FX.evaluate(s, now, ctx);

test('off y estados desconocidos son pantalla apagada (estado seguro)', () => {
  assert.deepEqual(ev(st({ effect: 'off', color: '#000000' }), 5000).rgb, [0, 0, 0]);
  assert.deepEqual(ev(st({ effect: 'raro', color: '#FFFFFF' }), 5000).rgb, [0, 0, 0]);
});

test('solid con transición: parte del color mostrado y llega al color pedido', () => {
  const s = st({ effect: 'solid', color: '#FF0000', fadeMs: 1000 });
  const from = [0, 0, 255];
  assert.deepEqual(ev(s, 1000, { from }).rgb.map(Math.round), [0, 0, 255]);
  const mid = ev(s, 1500, { from }).rgb; assert.ok(mid[0] > 100 && mid[0] < 160 && mid[2] > 100 && mid[2] < 160);
  assert.deepEqual(ev(s, 2500, { from }).rgb.map(Math.round), [255, 0, 0]);
});

test('sincronía: el mismo instante de servidor produce exactamente el mismo color en cualquier dispositivo', () => {
  const s = st({ effect: 'pulse', color: '#0A84FF', periodMs: 1700 });
  for (const now of [1000, 1234, 9876, 54321]) assert.deepEqual(ev(s, now), ev(JSON.parse(JSON.stringify(s)), now));
  const s2 = st({ effect: 'strobe', color: '#FFFFFF', hz: 2, duty: 0.25, durationMs: 10000 });
  for (const now of [1000, 1100, 1300, 1600, 2500]) assert.deepEqual(ev(s2, now).rgb, ev(s2, now).rgb);
});

test('pulso: oscila con el período indicado', () => {
  const s = st({ effect: 'pulse', color: '#FFFFFF', periodMs: 2000 });
  assert.equal(Math.round(ev(s, 1000).rgb[0]), 255);       // fase 0 = máximo
  assert.equal(Math.round(ev(s, 2000).rgb[0]), 0);         // media vuelta = mínimo
  assert.equal(Math.round(ev(s, 3000).rgb[0]), 255);       // vuelta completa
});

test('strobe: respeta la frecuencia (nunca más de 3 Hz) aunque se pida más, y termina al cumplirse la duración', () => {
  const s = st({ effect: 'strobe', color: '#FFFFFF', hz: 50, duty: 0.5, durationMs: 4000 });
  let flashes = 0; let prev = false;
  for (let t = 1000; t < 2000; t++) { const on = ev(s, t).rgb[0] > 128; if (on && !prev) flashes++; prev = on; }
  assert.ok(flashes <= 3, `destellos por segundo: ${flashes}`);
  assert.equal(ev(s, 1000).flashing, true);
  const after = ev(s, 6000);
  assert.deepEqual(after.rgb, [255, 255, 255]); assert.equal(after.flashing, false, 'termina en color fijo, no queda parpadeando');
});

test('reducir movimiento y conexión perdida convierten los efectos animados en color fijo', () => {
  const strobe = st({ effect: 'strobe', color: '#FF0000', hz: 2, durationMs: 10000 });
  const pulse = st({ effect: 'pulse', color: '#00FF00', periodMs: 1000 });
  for (const ctx of [{ reduced: true }, { stale: true }]) {
    for (const now of [1000, 1100, 1250, 1500]) { assert.deepEqual(ev(strobe, now, ctx).rgb, [255, 0, 0]); assert.deepEqual(ev(pulse, now, ctx).rgb, [0, 255, 0]); }
  }
});

test('la intensidad atenúa el brillo', () => {
  assert.deepEqual(ev(st({ effect: 'solid', color: '#FFFFFF', intensity: 0.5 }), 2000).rgb.map(Math.round), [128, 128, 128]);
});

test('defensa en profundidad del cliente: un estado hostil (hz enorme/negativo, duty alto, sin duración) nunca supera 3 Hz ni 30 s', () => {
  for (const p of [{ hz: 100, duty: 0.99 }, { hz: -5, duty: -1 }, { hz: 0, duty: 5 }, { hz: 'x', duty: 'y' }]) {
    const s = st({ effect: 'strobe', color: '#FFFFFF', durationMs: 0, ...p });
    let flashes = 0; let prev = false;
    for (let t = 1000; t < 2000; t++) { const on = ev(s, t).rgb[0] > 128; if (on && !prev) flashes++; prev = on; }
    assert.ok(flashes <= 3, `${JSON.stringify(p)}: ${flashes} destellos/s`);
    assert.equal(ev(s, 1000 + 29000).flashing === true || ev(s, 1000 + 29000).flashing === false, true);
    assert.equal(ev(s, 1000 + 31000).flashing, false, 'tras 30 s termina en color fijo aunque no tenga duración');
    assert.equal(ev(st({ effect: 'strobe', color: '#FFFFFF', hz: 2, durationMs: 1e9 }), 1000 + 31000).flashing, false, 'una duración desmedida tampoco pasa de 30 s');
  }
});

test('comandos consecutivos: la transición nueva parte EXACTAMENTE del color que se estaba mostrando (sin saltos)', () => {
  const a = st({ effect: 'solid', color: '#FF0000', fadeMs: 2000 }, 1000);
  const shownMid = ev(a, 1900, { from: [0, 0, 0] }).rgb;                    // a mitad de la transición A
  const b = st({ effect: 'solid', color: '#0000FF', fadeMs: 2000 }, 1900);   // llega B y se aplica en ese instante
  assert.deepEqual(ev(b, 1900, { from: shownMid }).rgb.map(Math.round), shownMid.map(Math.round));
  const later = ev(b, 2900, { from: shownMid }).rgb; assert.ok(later[2] > shownMid[2] && later[0] < shownMid[0]);
  assert.deepEqual(ev(b, 4000, { from: shownMid }).rgb.map(Math.round), [0, 0, 255]);
});

test('validPayload: el cliente ignora payloads malformados (tipos, colores, NaN, efectos desconocidos)', () => {
  assert.equal(FX.validPayload({ effect: 'solid', color: '#FF0000' }), true);
  assert.equal(FX.validPayload({ effect: 'off' }), true);
  assert.equal(FX.validPayload({ effect: 'strobe', color: '#FFFFFF', hz: 2, duty: 0.25, durationMs: 5000 }), true);
  for (const bad of [null, 'x', {}, { effect: 'boom', color: '#FFFFFF' }, { effect: 'solid' }, { effect: 'solid', color: 'rojo' }, { effect: 'solid', color: '#FFFFFF', fadeMs: NaN },
    { effect: 'solid', color: '#FFFFFF', fadeMs: '100' }, { effect: 'pulse', color: '#FFFFFF', periodMs: Infinity }, { effect: 'fade', color: '#FFFFFF', color2: 123 }]) {
    assert.equal(FX.validPayload(bad), false, JSON.stringify(bad));
  }
});
