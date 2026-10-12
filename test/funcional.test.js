'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, http, login, createSession, joinPublic, joinMaster, sleep, dev, Client } = require('./helpers');

const color = (c, extra = {}) => ({ protocolVersion: 1, type: 'command', payload: { effect: 'solid', color: c, ...extra } });

test('crear sesión, unirse desde varios dispositivos y recibir el mismo cambio de color', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const op = await login(srv.base);
  const s = await createSession(srv.base, op);
  assert.match(s.sessionId, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(s.code, s.sessionId, 'compatibilidad con el campo `code` de V3.0');
  assert.match(s.joinUrl, /\/\?s=[A-Z0-9]{6}&mode=remote$/);

  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phones = await Promise.all([1, 2, 3, 4, 5].map(n => joinPublic(srv.wsUrl, s.sessionId, dev(n))));
  for (const p of phones) { assert.equal(p.welcome.state.stateVersion, 0); assert.equal(p.welcome.state.payload.effect, 'off'); }

  master.send(color('#ff3b30', { fadeMs: 0 }));
  const ack = await master.waitFor('ack');
  assert.equal(ack.stateVersion, 1);
  const got = await Promise.all(phones.map(p => p.waitFor('state')));
  for (const g of got) {
    assert.equal(g.stateVersion, 1);
    assert.equal(g.payload.color, '#FF3B30');
    assert.ok(g.executeAt > g.serverTimestamp, 'executeAt debe estar en el futuro respecto del instante de aceptación');
    assert.equal(g.commandId, ack.commandId);
    assert.equal(g.sessionId, s.sessionId);
  }
  // todos reciben exactamente el mismo instante de ejecución
  assert.equal(new Set(got.map(g => g.executeAt)).size, 1);
});

test('el Master no cuenta como participante y se informa la presencia total', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phones = await Promise.all([1, 2, 3].map(n => joinPublic(srv.wsUrl, s.sessionId, dev(n))));
  const pres = await master.waitFor(m => m.type === 'presence' && m.connected === 3, 4000, 'presence 3');
  assert.equal(pres.connected, 3);
  assert.ok(pres.health && pres.health.status, 'la presencia incluye el estado de salud para advertencias del panel');
  phones[0].close();
  await master.waitFor(m => m.type === 'presence' && m.connected === 2, 4000, 'presence 2');
  assert.equal(srv.app.hub.stats().masters, 1);
});

test('las sesiones están aisladas entre sí', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const op = await login(srv.base);
  const a = await createSession(srv.base, op); const b = await createSession(srv.base, op);
  const ma = await joinMaster(srv.wsUrl, a.sessionId, a.masterToken);
  const pa = await joinPublic(srv.wsUrl, a.sessionId, dev(1));
  const pb = await joinPublic(srv.wsUrl, b.sessionId, dev(2));
  ma.send(color('#00C7BE'));
  await pa.waitFor('state');
  await sleep(300);
  assert.equal(pb.msgs.filter(m => m.type === 'state').length, 0, 'la sesión B no debe recibir órdenes de A');
});

test('efectos: pulso, fade, strobe (con habilitación explícita) y parada de emergencia', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phone = await joinPublic(srv.wsUrl, s.sessionId, dev(1));

  master.send({ protocolVersion: 1, type: 'command', payload: { effect: 'pulse', color: '#0A84FF', periodMs: 1500 } });
  assert.equal((await phone.waitFor('state')).payload.effect, 'pulse');
  master.send({ protocolVersion: 1, type: 'command', payload: { effect: 'fade', color: '#FF2D55', color2: '#0A84FF', fadeMs: 2000 } });
  assert.equal((await phone.waitFor('state')).payload.fadeMs, 2000);

  // strobe bloqueado por defecto
  master.send({ protocolVersion: 1, type: 'command', payload: { effect: 'strobe', color: '#FFFFFF' } });
  assert.equal((await master.waitFor('error')).code, 'STROBE_DISABLED');
  // habilitar exige reconocer la advertencia
  master.send({ protocolVersion: 1, type: 'setConfig', strobeEnabled: true });
  assert.equal((await master.waitFor('error')).code, 'RISK_NOT_ACKNOWLEDGED');
  master.send({ protocolVersion: 1, type: 'setConfig', strobeEnabled: true, acknowledgeRisk: true });
  await master.waitFor('config');
  master.send({ protocolVersion: 1, type: 'command', payload: { effect: 'strobe', color: '#FFFFFF', hz: 2, durationMs: 5000 } });
  const st = await phone.waitFor(m => m.type === 'state' && m.payload.effect === 'strobe');
  assert.equal(st.payload.hz, 2); assert.equal(st.payload.durationMs, 5000);

  // parada de emergencia: inmediata, vuelve al estado seguro
  master.send({ protocolVersion: 1, type: 'stop' });
  const stop = await phone.waitFor(m => m.type === 'state' && m.payload.effect === 'off');
  assert.ok(stop.executeAt <= Date.now() + 50, 'stop se ejecuta de inmediato');
  assert.equal(stop.payload.color, '#000000');
});

test('un dispositivo que se conecta después recibe el estado vigente, no el historial', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  for (const c of ['#FFFFFF', '#FF9F1C', '#34C759']) { master.send(color(c)); await master.waitFor('ack'); }
  const late = await joinPublic(srv.wsUrl, s.sessionId, dev(9));
  assert.equal(late.welcome.state.stateVersion, 3);
  assert.equal(late.welcome.state.payload.color, '#34C759');
  await sleep(250);
  assert.equal(late.msgs.filter(m => m.type === 'state').length, 0, 'no se reproducen órdenes históricas');
});

test('reconexión: el mismo deviceId no duplica participantes y el estado se recupera', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const p1 = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  master.send(color('#AF52DE')); await p1.waitFor('state');
  p1.terminate();                                         // corte abrupto (sin cierre limpio)
  await sleep(150);
  const p1b = await joinPublic(srv.wsUrl, s.sessionId, dev(1), { hello: { reconnect: true, resumeVersion: 1 } });
  assert.equal(p1b.welcome.state.stateVersion, 1);
  assert.equal(p1b.welcome.state.payload.color, '#AF52DE');
  assert.equal(srv.app.hub.stats().public, 1, 'no se multiplican los registros');
  assert.equal(srv.app.metrics.get('reconnects'), 1);
});

test('el mismo deviceId abierto dos veces reemplaza a la conexión anterior (sin duplicados)', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const a = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  const b = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  const closed = await a.waitClose();
  assert.equal(closed.code, 4002);
  assert.equal(srv.app.hub.stats().public, 1);
  assert.ok(b.welcome);
});

test('orden duplicada (mismo commandId) no se aplica ni se publica dos veces', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phone = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  const cmd = { ...color('#FF3B30'), commandId: 'cmd-repetido-001' };
  master.send(cmd); const a1 = await master.waitFor('ack');
  master.send(cmd); const a2 = await master.waitFor('ack');
  assert.equal(a1.stateVersion, 1); assert.equal(a2.stateVersion, 1); assert.equal(a2.duplicate, true);
  await phone.waitFor('state'); await sleep(250);
  assert.equal(phone.msgs.filter(m => m.type === 'state').length, 0);
});

test('las versiones son monotónicas aunque se envíen órdenes seguidas', async t => {
  const srv = await startServer({ masterCommandsPerSec: 100, masterCommandBurst: 100 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  for (let i = 0; i < 20; i++) master.send(color('#' + (i * 5 + 100).toString(16).padStart(2, '0').repeat(3)));
  const versions = [];
  for (let i = 0; i < 20; i++) versions.push((await master.waitFor('ack')).stateVersion);
  assert.deepEqual(versions, Array.from({ length: 20 }, (_, i) => i + 1));
});

test('confirmaciones de aplicación: el servidor distingue "aceptada" de "aplicada" y agrega estadísticas', async t => {
  const srv = await startServer({ onTimeToleranceMs: 100 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phones = await Promise.all([1, 2, 3, 4].map(n => joinPublic(srv.wsUrl, s.sessionId, dev(n))));
  master.send(color('#FFD400'));
  const ack = await master.waitFor('ack');                      // aceptada por el servidor
  const st = await Promise.all(phones.map(p => p.waitFor('state')));
  assert.ok(st[0].ackRate > 0);
  // sin confirmaciones todavía: ninguna aplicada
  const early = await master.waitFor(m => m.type === 'stats' && m.stateVersion === 1, 3000, 'stats');
  assert.equal(early.responded || 0, 0);
  const devs = [5, -20, 60, 400];
  phones.forEach((p, i) => p.send({ protocolVersion: 1, type: 'applied', commandId: ack.commandId, stateVersion: 1, deviationMs: devs[i], receiveLeadMs: i === 3 ? -50 : 300 }));
  const stats = await master.waitFor(m => m.type === 'stats' && m.responded === 4, 5000, 'stats 4');
  assert.equal(stats.onTime, 3); assert.equal(stats.late, 1); assert.equal(stats.lateArrival, 1);
  assert.equal(stats.onTimePct, 75);
});
