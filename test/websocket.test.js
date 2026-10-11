'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { startServer, http, login, createSession, joinPublic, joinMaster, joinMany, sleep, dev, Client } = require('./helpers');

const cmd = (c = '#FF3B30') => ({ protocolVersion: 1, type: 'command', payload: { effect: 'solid', color: c } });

test('mensajes malformados no tumban el proceso ni a los demás clientes', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const good = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const bad = await joinPublic(srv.wsUrl, s.sessionId, dev(2));
  const junk = ['not json', '[]', 'null', '123', '"x"', '{}', '{"type":"nope"}', '{"type":"ping"}', '{"type":"ping","t0":"x"}',
    '{"type":"applied"}', '{"type":"applied","commandId":"c1","stateVersion":-1,"deviationMs":0}', '{"type":"hello","role":"public","sessionId":"AAAAAA"}',
    '{"protocolVersion":99,"type":"ping","t0":1}', '{"type":"ping","t0":1,"__proto__":{"x":1}}'];
  for (const j of junk) { bad.send(j); await sleep(25); }
  await sleep(100);
  assert.ok(srv.app.metrics.get('protocol_errors') >= 8);
  master.send(cmd('#0A84FF'));
  assert.equal((await good.waitFor('state')).payload.color, '#0A84FF', 'los demás clientes siguen funcionando');
});

test('mensajes demasiado grandes cierran la conexión con 1009 sin afectar al servidor', async t => {
  const srv = await startServer({ maxMessageBytes: 512 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const c = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  c.send(JSON.stringify({ type: 'ping', t0: 1, pad: 'x'.repeat(2000) }));
  assert.equal((await c.waitClose()).code, 1009);
  const ok = await joinPublic(srv.wsUrl, s.sessionId, dev(2));
  assert.ok(ok.welcome);
});

test('mensajes binarios se rechazan', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const c = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  c.ws.send(Buffer.from([1, 2, 3]));
  assert.equal((await c.waitClose()).code, 1003);
});

test('conexión que no envía hello es cerrada por timeout; mensajes antes del hello también', async t => {
  const srv = await startServer({ helloTimeoutMs: 500 }); t.after(srv.stop);
  const idle = await new Client(srv.wsUrl).open();
  assert.equal((await idle.waitClose()).code, 4408);
  const eager = await new Client(srv.wsUrl).open();
  eager.send({ protocolVersion: 1, type: 'ping', t0: 1 });
  assert.equal((await eager.waitFor('error')).code, 'NOT_JOINED');
  assert.equal((await eager.waitClose()).code, 1008);
});

test('desconexión inesperada: el participante se elimina y el contador baja', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const phones = await Promise.all([1, 2, 3, 4].map(n => joinPublic(srv.wsUrl, s.sessionId, dev(n))));
  await master.waitFor(m => m.type === 'presence' && m.connected === 4, 4000, 'presence 4');
  phones[0].terminate(); phones[1].terminate();
  await master.waitFor(m => m.type === 'presence' && m.connected === 2, 4000, 'presence 2');
  assert.equal(srv.app.hub.stats().public, 2);
});

test('heartbeat fallido: un cliente que no responde a los ping es terminado y liberado', async t => {
  const srv = await startServer({ heartbeatMs: 2000 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const ws = new WebSocket(srv.wsUrl, { autoPong: false });
  await new Promise(r => ws.once('open', r));
  ws.send(JSON.stringify({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: s.sessionId, deviceId: dev(1) }));
  await new Promise(r => ws.once('message', r));
  assert.equal(srv.app.hub.stats().public, 1);
  const closed = await new Promise(r => { const t0 = Date.now(); ws.once('close', () => r(Date.now() - t0)); });
  assert.ok(closed <= 5000, `liberado en ${closed} ms`);
  await sleep(50);
  assert.equal(srv.app.hub.stats().public, 0);
  assert.ok(srv.app.metrics.get('heartbeat_timeouts') >= 1);
});

test('el tráfico de la aplicación también cuenta como señal de vida (cliente que responde ping de aplicación no se corta)', async t => {
  const srv = await startServer({ heartbeatMs: 2000 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const c = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  for (let i = 0; i < 5; i++) { c.send({ protocolVersion: 1, type: 'ping', t0: Date.now() }); await c.waitFor('pong'); await sleep(900); }
  assert.equal(c.closed, null);
});

test('abuso de frecuencia: un participante que inunda el canal es cortado; el Master conserva la parada de emergencia', async t => {
  const srv = await startServer({ publicMsgPerSec: 5, publicMsgBurst: 10, masterCommandsPerSec: 2, masterCommandBurst: 3 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const flood = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  for (let i = 0; i < 80; i++) flood.send({ protocolVersion: 1, type: 'ping', t0: i });
  assert.equal((await flood.waitClose()).code, 4429);

  const phone = await joinPublic(srv.wsUrl, s.sessionId, dev(2));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  for (let i = 0; i < 12; i++) master.send(cmd('#FF3B30'));
  await sleep(300);
  assert.ok(srv.app.metrics.get('rate_limited_commands') >= 5, 'las órdenes en ráfaga se limitan');
  master.send({ protocolVersion: 1, type: 'stop' });            // prioritaria: no consume cupo de frecuencia
  const stop = await phone.waitFor(m => m.type === 'state' && m.payload.effect === 'off', 2000, 'stop');
  assert.equal(stop.payload.effect, 'off');
});

// ---------------------------------------------------------------- contrapresión con un socket simulado (cliente lento)
function fakeWs() {
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: WebSocket.OPEN, bufferedAmount: 0, sent: [], terminated: false, closedWith: null,
    send(raw) { this.sent.push(JSON.parse(raw)); }, ping() {}, terminate() { this.terminated = true; this.readyState = WebSocket.CLOSED; this.emit('close', 1006); },
    close(code) { this.closedWith = code; this.readyState = WebSocket.CLOSED; this.emit('close', code); } });
  return ws;
}
async function fakeJoin(hub, ws, sessionId, deviceId) {
  hub.accept(ws, {}, '1.2.3.4');
  ws.emit('message', Buffer.from(JSON.stringify({ protocolVersion: 1, type: 'hello', role: 'public', sessionId, deviceId })), false);
  for (let i = 0; i < 50 && !ws.sent.some(m => m.type === 'welcome'); i++) await sleep(10);
}

test('cliente lento: se omiten envíos, se reenvía el estado vigente al liberarse y los demás no se ven afectados', async t => {
  const srv = await startServer({ bufferSoftBytes: 1000, bufferHardBytes: 100000, slowStrikes: 50, masterCommandsPerSec: 100, masterCommandBurst: 100 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const healthy = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  const slow = fakeWs(); await fakeJoin(srv.app.hub, slow, s.sessionId, dev(2));
  slow.bufferedAmount = 5000;                                       // el buffer de salida está lleno
  const before = slow.sent.length;
  for (const c of ['#FF0000', '#00FF00', '#0000FF']) { master.send(cmd(c)); await master.waitFor('ack'); }
  await sleep(150);
  assert.equal(slow.sent.length, before, 'no se escribe en un socket con buffer lleno');
  assert.ok(srv.app.metrics.get('ws_backpressure_skips') >= 3);
  for (let i = 0; i < 3; i++) await healthy.waitFor('state');      // el sano recibió las 3 órdenes
  slow.bufferedAmount = 0;                                          // se libera
  await sleep(1300);
  const last = slow.sent.filter(m => m.type === 'state').pop();
  assert.equal(last.stateVersion, 3, 'recibe el estado VIGENTE (coalescencia), no las intermedias');
  assert.equal(last.resync, true);
  assert.ok(!slow.terminated);
});

test('cliente demasiado lento: se cierra al superar el límite duro del buffer', async t => {
  const srv = await startServer({ bufferSoftBytes: 1000, bufferHardBytes: 4000 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const slow = fakeWs(); await fakeJoin(srv.app.hub, slow, s.sessionId, dev(2));
  slow.bufferedAmount = 50000;
  master.send(cmd()); await master.waitFor('ack');
  await sleep(100);
  assert.ok(slow.terminated);
  assert.equal(srv.app.hub.stats().public, 0, 'recursos liberados');
  assert.ok(srv.app.metrics.get('ws_slow_closed') >= 1);
});

// ---------------------------------------------------------------- reinicios y despliegues
test('apagado ordenado (SIGTERM): avisa, cierra con 1012 de forma escalonada y los clientes pueden reconectar a la instancia nueva', async t => {
  const srv = await startServer({ shutdownSpreadMs: 600 });
  const s = await createSession(srv.base, await login(srv.base));
  const phones = await Promise.all(Array.from({ length: 30 }, (_, i) => joinPublic(srv.wsUrl, s.sessionId, dev(i + 1))));
  const t0 = Date.now();
  const done = srv.stop();
  const closes = await Promise.all(phones.map(async p => { const c = await p.waitClose(5000); return { code: c.code, at: Date.now() - t0 }; }));
  await done;
  assert.ok(closes.every(c => c.code === 1012), 'todos reciben 1012 (reinicio): el cliente debe reconectar con jitter');
  const spread = Math.max(...closes.map(c => c.at)) - Math.min(...closes.map(c => c.at));
  assert.ok(spread >= 200, `cierre escalonado (dispersión ${spread} ms)`);
  assert.ok(phones.every(p => p.msgs.some(m => m.type === 'restart' && m.reconnectAfterMs >= 500)), 'reciben aviso con tiempo de reconexión sugerido');
  await assert.rejects(fetch(srv.base + '/healthz'), 'el proceso ya no acepta conexiones');
});

test('tras un reinicio SIN almacenamiento compartido la sesión se pierde y el operador puede re-crearla con el mismo código', async t => {
  let srv = await startServer();
  const op = await login(srv.base);
  const s = await createSession(srv.base, op);
  const phone = await joinPublic(srv.wsUrl, s.sessionId, dev(1));
  const port = srv.port;
  await srv.stop();
  await phone.waitClose();
  srv = await startServer({ port }); t.after(srv.stop);
  const c = await new Client(srv.wsUrl).open();
  c.send({ protocolVersion: 1, type: 'hello', role: 'public', sessionId: s.sessionId, deviceId: dev(1), reconnect: true });
  assert.equal((await c.waitFor('error')).code, 'SESSION_NOT_FOUND');
  const op2 = await login(srv.base);
  const re = await http(srv.base, 'POST', '/api/sessions', { token: op2, body: { sessionId: s.sessionId } });
  assert.equal(re.status, 201); assert.equal(re.json.sessionId, s.sessionId);
  assert.equal((await http(srv.base, 'POST', '/api/sessions', { token: op2, body: { sessionId: s.sessionId } })).status, 409);
  const back = await joinPublic(srv.wsUrl, s.sessionId, dev(1), { hello: { reconnect: true } });
  assert.equal(back.welcome.state.stateVersion, 0);
});

test('reconexión simultánea de muchos clientes tras un corte: todos vuelven y no se duplican registros', async t => {
  const srv = await startServer({ wsConnectPerMinPerIp: 100000 }); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const N = 400;
  let phones = await joinMany(srv.wsUrl, s.sessionId, N);
  assert.equal(srv.app.hub.stats().public, N);
  for (const p of phones) p.terminate();                              // corte masivo simultáneo
  phones = await joinMany(srv.wsUrl, s.sessionId, N, { hello: { reconnect: true } });
  assert.equal(phones.length, N);
  await sleep(200);
  assert.equal(srv.app.hub.stats().public, N, 'sin duplicados');
  assert.ok(srv.app.metrics.get('reconnects') >= N);
});
