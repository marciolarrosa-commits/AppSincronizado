'use strict';
// Multi-evento (V4.0): ciclo de vida, validación, aislamiento entre eventos, política de efectos, QR /e/CODIGO y compatibilidad con los QR anteriores.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, http, login, createSession, joinPublic, joinMaster, sleep, dev, Client } = require('./helpers');

const CFG = { strobeAllowed: false };
const ev = (token, base, body) => http(base, 'POST', '/api/events', { token, body });

async function newActive(base, token, name, config) {
  const c = await ev(token, base, { name, ...(config ? { config } : {}) });
  assert.equal(c.status, 201, c.text);
  const id = c.json.event.id;
  const a = await http(base, 'POST', `/api/events/${id}/status`, { token, body: { status: 'active' } });
  assert.equal(a.status, 200, a.text);
  return a.json.event;
}
async function operate(base, wsUrl, token, event) {
  const t = await http(base, 'POST', `/api/events/${event.id}/master-token`, { token, body: {} });
  assert.equal(t.status, 200, t.text);
  const m = await joinMaster(wsUrl, t.json.sessionId, t.json.masterToken);
  return { m, info: t.json };
}
const solid = (color, id) => ({ protocolVersion: 1, type: 'command', commandId: id, leadMs: 300, payload: { effect: 'solid', color, fadeMs: 0 } });

test('API de eventos: exige operador; crear, leer, editar y validar', async () => {
  const s = await startServer(CFG);
  try {
    assert.equal((await http(s.base, 'GET', '/api/events')).status, 401);
    assert.equal((await http(s.base, 'POST', '/api/events', { body: { name: 'x' } })).status, 401);
    const token = await login(s.base);

    const c = await ev(token, s.base, { name: '  Recibimiento del Papa  ', description: 'Estadio', startsAt: Date.now() + 86400000 });
    assert.equal(c.status, 201);
    const e = c.json.event;
    assert.match(e.id, /^ev_[0-9a-f]{16}$/);
    assert.match(e.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(e.name, 'Recibimiento del Papa');
    assert.equal(e.status, 'draft');
    assert.equal(e.url, `${s.base}/e/${e.code}`);
    assert.ok(e.config.colors.length >= 1 && !e.config.effectsAllowed.includes('strobe'));

    // validación estricta
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(81) }, { name: 'a', config: { colors: ['rojo'] } }, { name: 'a', config: { efectoRaro: 1 } },
      { name: 'a', config: { effectsAllowed: ['strobe'] } },                 // strobe deshabilitado en el servidor
      { name: 'a', config: { sequences: [{ name: 's', steps: [{ color: '#FF0000', holdMs: 100 }, { color: '#00FF00', holdMs: 1000 }] }] } },
      { name: 'a', startsAt: 'mañana' }]) {
      const r = await ev(token, s.base, body);
      assert.equal(r.status, 400, JSON.stringify(body) + ' → ' + r.text);
      assert.equal(r.json.error, 'INVALID_EVENT');
    }

    const u = await http(s.base, 'POST', `/api/events/${e.id}/update`, { token, body: { name: 'Apertura', config: { colors: ['#ff0000', '#00ff00'], sequences: [{ name: 'Bandera', steps: [{ color: '#0000ff', holdMs: 1000 }, { color: '#ffffff', holdMs: 1000 }] }] } } });
    assert.equal(u.status, 200, u.text);
    assert.deepEqual(u.json.event.config.colors, ['#FF0000', '#00FF00']);
    assert.equal(u.json.event.config.sequences[0].steps[0].color, '#0000FF');
    assert.equal((await http(s.base, 'POST', `/api/events/${e.id}/update`, { token, body: { code: 'AAAAAA' } })).status, 400, 'el código no se edita');
    assert.equal((await http(s.base, 'GET', `/api/events/${e.id}`, { token })).json.event.name, 'Apertura');
    assert.equal((await http(s.base, 'GET', '/api/events/ev_0000000000000000', { token })).status, 404);
    assert.equal((await http(s.base, 'GET', '/api/events/zzz', { token })).status, 404);
    const aud = await http(s.base, 'GET', `/api/events/${e.id}/audit`, { token });
    assert.deepEqual(aud.json.audit.map(a => a.action), ['update', 'create']);
    assert.match(aud.json.audit[0].actor, /^op:[0-9a-f]{12}$/);
  } finally { await s.stop(); }
});

test('ciclo de vida: un QR de evento solo entra mientras está activo; transiciones inválidas, archivado protegido, duplicado', async () => {
  const s = await startServer(CFG);
  try {
    const token = await login(s.base);
    const e = (await ev(token, s.base, { name: 'Concierto' })).json.event;

    // borrador: nadie entra (la sesión no existe) y no se puede operar
    const early = await new Client(s.wsUrl).open(); early.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: e.code, deviceId: dev(1) });
    assert.equal((await early.waitFor('error')).code, 'SESSION_NOT_FOUND'); await early.waitClose();
    assert.equal((await http(s.base, 'POST', `/api/events/${e.id}/master-token`, { token, body: {} })).json.error, 'EVENT_NOT_ACTIVE');

    const st = (id, status) => http(s.base, 'POST', `/api/events/${id}/status`, { token, body: { status } });
    assert.equal((await st(e.id, 'finished')).json.error, 'INVALID_TRANSITION', 'borrador → finalizado no existe');
    assert.equal((await st(e.id, 'inexistente')).status, 400);
    assert.equal((await st(e.id, 'active')).json.event.status, 'active');

    const p = await joinPublic(s.wsUrl, e.code, dev(1));
    assert.equal(p.welcome.sessionId, e.code);

    // archivar activo: rechazado; sin confirmación: rechazado
    assert.equal((await http(s.base, 'POST', `/api/events/${e.id}/archive`, { token, body: { confirm: e.code } })).json.error, 'EVENT_ACTIVE');

    // desactivar → los teléfonos reciben un cierre de «espera» (4404), no definitivo
    const closing = p.waitClose();
    assert.equal((await st(e.id, 'scheduled')).json.event.status, 'scheduled');
    assert.equal((await closing).code, 4404);

    // reactivar y finalizar → cierre definitivo (4410) y estado terminal
    await st(e.id, 'active');
    const p2 = await joinPublic(s.wsUrl, e.code, dev(2));
    const closing2 = p2.waitClose();
    assert.equal((await st(e.id, 'finished')).json.event.status, 'finished');
    assert.equal((await closing2).code, 4410);
    assert.equal((await st(e.id, 'active')).json.error, 'INVALID_TRANSITION');
    assert.equal((await http(s.base, 'POST', `/api/events/${e.id}/update`, { token, body: { name: 'otro' } })).json.error, 'EVENT_FINISHED');

    // archivado lógico con confirmación; el registro y la auditoría se conservan
    assert.equal((await http(s.base, 'POST', `/api/events/${e.id}/archive`, { token, body: {} })).json.error, 'CONFIRMATION_REQUIRED');
    assert.equal((await http(s.base, 'POST', `/api/events/${e.id}/archive`, { token, body: { confirm: 'XXXXXX' } })).json.error, 'CONFIRMATION_REQUIRED');
    const ar = await http(s.base, 'POST', `/api/events/${e.id}/archive`, { token, body: { confirm: e.code } });
    assert.equal(ar.json.event.archived, true);
    assert.equal((await http(s.base, 'GET', '/api/events', { token })).json.events.length, 0);
    assert.equal((await http(s.base, 'GET', '/api/events?archived=1', { token })).json.events.length, 1);
    assert.ok((await http(s.base, 'GET', `/api/events/${e.id}/audit`, { token })).json.audit.length >= 6);
    assert.equal((await st(e.id, 'draft')).json.error, 'EVENT_ARCHIVED');
    assert.equal((await http(s.base, 'POST', `/api/events/${e.id}/restore`, { token, body: {} })).json.event.archived, false);

    // duplicar: código y QR nuevos, borrador, misma configuración
    const d = (await http(s.base, 'POST', `/api/events/${e.id}/duplicate`, { token, body: {} })).json.event;
    assert.notEqual(d.id, e.id); assert.notEqual(d.code, e.code); assert.equal(d.status, 'draft'); assert.equal(d.name, 'Concierto (copia)');
    assert.deepEqual(d.config, e.config);
  } finally { await s.stop(); }
});

test('códigos únicos: una sesión suelta no puede ocupar el código de un evento ni suplantar su QR', async () => {
  const s = await startServer(CFG);
  try {
    const token = await login(s.base);
    const e = (await ev(token, s.base, { name: 'A' })).json.event;      // borrador: la sesión aún no existe, pero el código está reservado
    const r = await http(s.base, 'POST', '/api/sessions', { token, body: { sessionId: e.code } });
    assert.equal(r.status, 409);
    const codes = new Set(); for (let i = 0; i < 25; i++) codes.add((await ev(token, s.base, { name: 'E' + i })).json.event.code);
    assert.equal(codes.size, 25, 'ningún código se repite');
  } finally { await s.stop(); }
});

test('AISLAMIENTO: dos eventos activos con participantes y órdenes propios no se comunican (estado, versiones, presencia, órdenes, cierre)', async () => {
  const s = await startServer(CFG);
  try {
    const token = await login(s.base);
    const A = await newActive(s.base, token, 'Evento A'); const B = await newActive(s.base, token, 'Evento B');
    assert.notEqual(A.code, B.code);
    const opA = await operate(s.base, s.wsUrl, token, A); const opB = await operate(s.base, s.wsUrl, token, B);
    const pa = []; const pb = [];
    for (let i = 0; i < 6; i++) pa.push(await joinPublic(s.wsUrl, A.code, dev(i)));
    for (let i = 0; i < 4; i++) pb.push(await joinPublic(s.wsUrl, B.code, dev(100 + i)));     // dispositivos distintos
    // el MISMO deviceId en dos eventos son dos participantes distintos (la clave de dispositivo es por sala)
    const twinA = await joinPublic(s.wsUrl, A.code, 'device-compartido'); const twinB = await joinPublic(s.wsUrl, B.code, 'device-compartido');

    opA.m.send(solid('#FF0000', 'cmd-a-0001'));
    const ackA = await opA.m.waitFor('ack'); assert.equal(ackA.stateVersion, 1); await opA.m.waitFor('state');      // el Master también recibe su propia orden difundida
    for (const c of [...pa, twinA]) { const m = await c.waitFor('state'); assert.equal(m.payload.color, '#FF0000'); assert.equal(m.sessionId, A.code); }
    await sleep(400);
    for (const c of [...pb, twinB, opB.m]) assert.equal(c.msgs.filter(m => m.type === 'state').length, 0, 'el evento B no recibe órdenes del A');
    assert.equal(twinB.closed, null, 'el gemelo de B no fue reemplazado por el de A');

    opB.m.send(solid('#0000FF', 'cmd-b-0001'));
    assert.equal((await opB.m.waitFor('ack')).stateVersion, 1, 'cada evento lleva su propia versión'); await opB.m.waitFor('state');
    for (const c of [...pb, twinB]) { const m = await c.waitFor('state'); assert.equal(m.payload.color, '#0000FF'); assert.equal(m.sessionId, B.code); }
    await sleep(300);
    for (const c of [...pa, twinA, opA.m]) assert.equal(c.msgs.filter(m => m.type === 'state').length, 0, 'el evento A no recibe órdenes del B');

    // un participante de A no puede dar órdenes, y un token de Master de A no sirve para B
    pa[0].send(solid('#00FF00', 'cmd-hack-01')); assert.equal((await pa[0].waitFor('error')).code, 'FORBIDDEN');
    const cross = await new Client(s.wsUrl).open(); cross.send({ protocolVersion: 1, type: 'hello', role: 'master', sessionId: B.code, token: opA.info.masterToken });
    assert.equal((await cross.waitFor('error')).code, 'UNAUTHORIZED'); await cross.waitClose();

    // presencia y estadísticas por evento
    await sleep(700);
    const sa = (await http(s.base, 'GET', `/api/events/${A.id}/stats`, { token })).json; const sb = (await http(s.base, 'GET', `/api/events/${B.id}/stats`, { token })).json;
    assert.equal(sa.connected, 7); assert.equal(sb.connected, 5);
    assert.equal(sa.lastOrder.color, '#FF0000'); assert.equal(sb.lastOrder.color, '#0000FF');

    // cerrar el evento A no toca al B
    const closing = pa[1].waitClose();
    await http(s.base, 'POST', `/api/events/${A.id}/status`, { token, body: { status: 'finished' } });
    assert.equal((await closing).code, 4410);
    await sleep(200);
    assert.equal(pb[0].closed, null); assert.equal(opB.m.closed, null);
    opB.m.send(solid('#FFFFFF', 'cmd-b-0002')); assert.equal((await opB.m.waitFor('ack')).stateVersion, 2);
    assert.equal(s.app.hub.stats().perSession.length, 1, 'la sala del evento cerrado se liberó');
  } finally { await s.stop(); }
});

test('política del evento: efectos no permitidos y evento inactivo se rechazan en el SERVIDOR; el margen del evento es un mínimo', async () => {
  const s = await startServer(CFG);
  try {
    const token = await login(s.base);
    const E = await newActive(s.base, token, 'Solo color fijo', { effectsAllowed: ['solid'], leadMs: 2500 });
    const { m } = await operate(s.base, s.wsUrl, token, E);
    m.send({ protocolVersion: 1, type: 'command', commandId: 'cmd-seq-001', payload: { effect: 'pulse', color: '#FF0000', color2: '#000000', periodMs: 2000, durationMs: 10000 } });
    const err = await m.waitFor('error'); assert.equal(err.code, 'EFFECT_NOT_ALLOWED'); assert.equal(err.commandId, 'cmd-seq-001');
    const t0 = Date.now(); m.send(solid('#FFFFFF', 'cmd-ok-0001'));
    const ack = await m.waitFor('ack'); assert.ok(ack.executeAt - t0 >= 2400, 'margen mínimo del evento (' + (ack.executeAt - t0) + ' ms)');
    // strobe nunca: el servidor lo tiene deshabilitado por defecto
    m.send({ protocolVersion: 1, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: true });
    assert.equal((await m.waitFor('error')).code, 'STROBE_DISABLED');
    // detener el evento mientras el Master sigue conectado: el Master también es cerrado
    const mc = m.waitClose();
    await http(s.base, 'POST', `/api/events/${E.id}/status`, { token, body: { status: 'cancelled' } });
    assert.equal((await mc).code, 4410);
  } finally { await s.stop(); }
});

test('STROBE_ALLOWED=false es el valor predeterminado de V4.0 y el cliente recibe la ráfaga de reloj repartida en el welcome', async () => {
  const { loadConfig } = require('../src/config');
  const cfg = loadConfig({ NODE_ENV: 'development' }, { tokenSecret: 'x'.repeat(40) });
  assert.equal(cfg.strobeAllowed, false);
  assert.equal(cfg.clockBurstCount, 3); assert.equal(cfg.clockBurstCountResync, 1); assert.equal(cfg.clockBurstWindowMs, 3000);
  assert.equal(loadConfig({ NODE_ENV: 'development', STROBE_ALLOWED: 'true' }, { tokenSecret: 'x'.repeat(40) }).strobeAllowed, true);
  const s = await startServer({ strobeAllowed: false });
  try {
    const token = await login(s.base); const sess = await createSession(s.base, token);
    const p = await joinPublic(s.wsUrl, sess.sessionId, dev(1));
    assert.equal(p.welcome.config.strobeAllowed, false); assert.equal(p.welcome.config.strobeEnabled, false);
    assert.equal(p.welcome.config.clockBurstCount, 3); assert.equal(p.welcome.config.clockBurstWindowMs, 3000);
  } finally { await s.stop(); }
});

test('QR: /e/CODIGO sirve la página del participante SIN revelar si el evento existe; los QR anteriores /?s=…&mode=remote siguen funcionando', async () => {
  const s = await startServer();
  try {
    const token = await login(s.base);
    const e = (await ev(token, s.base, { name: 'QR' })).json.event;
    const real = await http(s.base, 'GET', `/e/${e.code}`); const fake = await http(s.base, 'GET', '/e/ZZZZZZ');
    assert.equal(real.status, 200); assert.equal(fake.status, 200);
    assert.equal(real.text, fake.text, 'la respuesta es idéntica exista o no el evento');
    assert.match(real.headers.get('content-type'), /text\/html/);
    assert.ok(real.text.includes('/js/remote.js'));
    assert.equal((await http(s.base, 'GET', '/e/ABC')).status, 404, 'formato inválido');
    assert.equal((await http(s.base, 'GET', '/e/')).status, 404);
    // QR anterior de una sesión suelta
    const sess = await createSession(s.base, token);
    const old = await http(s.base, 'GET', `/?s=${sess.sessionId}&mode=remote`); assert.equal(old.status, 200); assert.equal(old.text, real.text);
    const p = await joinPublic(s.wsUrl, sess.sessionId, dev(1)); assert.equal(p.welcome.sessionId, sess.sessionId);
    // la CSP de la página cubre el script en línea (hash)
    assert.match(real.headers.get('content-security-policy'), /script-src[^;]*sha256-/);
  } finally { await s.stop(); }
});

test('panel general: totales, participantes por evento, infraestructura y alertas', async () => {
  const s = await startServer();
  try {
    const token = await login(s.base);
    const A = await newActive(s.base, token, 'Activo'); await ev(token, s.base, { name: 'Borrador' });
    const past = await ev(token, s.base, { name: 'Atrasado', startsAt: Date.now() - 1000 });
    await http(s.base, 'POST', `/api/events/${past.json.event.id}/status`, { token, body: { status: 'scheduled' } });
    for (let i = 0; i < 3; i++) await joinPublic(s.wsUrl, A.code, dev(i));
    await sleep(700);
    const d = (await http(s.base, 'GET', '/api/events/dashboard', { token })).json;
    assert.equal(d.events.total, 3); assert.equal(d.events.active, 1); assert.equal(d.events.byStatus.draft, 1); assert.equal(d.events.byStatus.scheduled, 1);
    assert.equal(d.connectedTotal, 3); assert.equal(d.perEvent[0].connected, 3);
    assert.equal(d.infrastructure.store.ok, true); assert.equal(d.infrastructure.instances, 1);
    assert.ok(d.alerts.some(a => /debía comenzar/.test(a.text)));
    assert.ok(d.problemEvents.includes(past.json.event.id));
    assert.equal((await http(s.base, 'GET', '/api/events/dashboard')).status, 401);
  } finally { await s.stop(); }
});

test('concurrencia: la edición con revisión vieja se rechaza (409) en vez de pisar el cambio de otro operador', async () => {
  const s = await startServer();
  try {
    const token = await login(s.base);
    const e = (await ev(token, s.base, { name: 'Carrera' })).json.event;
    const a = await http(s.base, 'POST', `/api/events/${e.id}/update`, { token, body: { name: 'Uno', rev: e.rev } });
    assert.equal(a.status, 200);
    const b = await http(s.base, 'POST', `/api/events/${e.id}/update`, { token, body: { name: 'Dos', rev: e.rev } });
    assert.equal(b.status, 409); assert.equal(b.json.error, 'EVENT_CONFLICT');
    assert.equal((await http(s.base, 'GET', `/api/events/${e.id}`, { token })).json.event.name, 'Uno');
  } finally { await s.stop(); }
});
