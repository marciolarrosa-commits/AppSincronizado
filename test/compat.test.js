'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, login, createSession, joinMaster, Client, dev } = require('./helpers');

test('compatibilidad V3.0: un teléfono con la página anterior (/ws?session=..&role=public) sigue recibiendo órdenes', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const master = await joinMaster(srv.wsUrl, s.sessionId, s.masterToken);
  const old = await new Client(`${srv.wsUrl}?session=${s.sessionId}&role=public&deviceId=${dev(7)}`).open();
  const hello = await old.waitFor('hello');
  assert.equal(hello.role, 'public'); assert.equal(hello.session, s.sessionId); assert.equal(hello.state.active, false);
  old.send({ type: 'ping', clientTime: 123 });
  const pong = await old.waitFor('pong'); assert.equal(pong.clientTime, 123); assert.ok(pong.serverTime > 0);
  master.send({ protocolVersion: 1, type: 'command', payload: { effect: 'pulse', color: '#FF2D55' } });
  const st = await old.waitFor('state');
  assert.equal(st.state.color, '#FF2D55'); assert.equal(st.state.effect, 'pulse'); assert.equal(st.state.version, 1); assert.equal(st.state.active, true);
  assert.ok(st.state.executeAt > st.serverTime - 5);
  // cuenta como participante, pero no puede mandar órdenes
  assert.equal(srv.app.hub.stats().public, 1);
  old.send({ type: 'command', color: '#FFFFFF' });
  await new Promise(r => setTimeout(r, 200));
  assert.equal((await srv.app.sessions.get(s.sessionId)).state.stateVersion, 1);
});

test('compatibilidad V3.0: sesión inexistente se rechaza también para páginas antiguas', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const old = await new Client(`${srv.wsUrl}?session=ZZZZZZ&role=public&deviceId=${dev(1)}`).open();
  assert.equal((await old.waitClose()).code, 4404);
});

test('el Master antiguo (sin autenticación, token en la URL) ya NO es compatible: no se puede controlar nada', async t => {
  const srv = await startServer(); t.after(srv.stop);
  const s = await createSession(srv.base, await login(srv.base));
  const old = await new Client(`${srv.wsUrl}?session=${s.sessionId}&role=master&token=${s.masterToken}`).open();
  // role=master en la URL no se interpreta: la conexión espera un hello y expira
  assert.equal((await old.waitClose()).code, 4408);
});
