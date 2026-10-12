'use strict';
// Registros (V3.5.0): redacción por nombre y por VALOR, neutralización de caracteres de control (inyección de líneas) y que la IP registrada es siempre una IP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, redact, scrubString } = require('../src/logger');
const { startServer, http, PASSWORD } = require('./helpers');

test('scrubString: saltos de línea y caracteres de control no pueden falsificar entradas; tokens, Bearer y credenciales en URL se enmascaran dentro de cualquier texto', () => {
  const hostile = 'fallo\n{"ts":"x","level":"info","msg":"login_ok"}\r\n' + String.fromCharCode(7) + String.fromCharCode(0x2028) + 'fin'; const forged = scrubString(hostile);
  for (const bad of ['\n', '\r', String.fromCharCode(7), String.fromCharCode(0x2028)]) assert.ok(!forged.includes(bad), 'sin caracteres de control: ' + JSON.stringify(forged));
  const tok = 'eyJ2IjoxLCJyIjoib3AiLCJpYXQiOjE3fQ.AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  for (const [input, secret] of [[`error con token ${tok} dentro`, tok], ['cabecera Authorization: Bearer abcdef0123456789xyz', 'abcdef0123456789xyz'], ['redis://usuario:Cl4ve-Sup3r@10.0.0.5:6379/0', 'Cl4ve-Sup3r'], ['Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA==']])
    assert.ok(!scrubString(input).includes(secret), `se enmascara: ${input.slice(0, 40)} -> ${scrubString(input)}`);
  assert.equal(scrubString('mensaje normal con números 12345 y texto'), 'mensaje normal con números 12345 y texto', 'el texto corriente no se altera');
  assert.equal(scrubString('a'.repeat(1000)).length, 301, 'se recorta a 300 caracteres (+ puntos suspensivos)');
});

test('redact: por nombre de campo (token, password, secret, authorization, cookie, key) y por valor, también en objetos anidados y listas', () => {
  const out = redact({ ok: 'visible', password: 'p', masterToken: 't', nested: { authorization: 'Bearer abcdefghij12345', apiKey: 'k', note: 'redis://u:Secreta1@h' }, lista: ['Bearer zzzzzzzzzzzz', 'normal'] });
  assert.equal(out.ok, 'visible'); assert.equal(out.password, '[REDACTED]'); assert.equal(out.masterToken, '[REDACTED]'); assert.equal(out.nested.authorization, '[REDACTED]'); assert.equal(out.nested.apiKey, '[REDACTED]');
  assert.ok(!out.nested.note.includes('Secreta1')); assert.ok(!out.lista[0].includes('zzzzzzzzzzzz')); assert.equal(out.lista[1], 'normal');
  assert.equal(redact(5), 5); assert.equal(redact(null), null);
});

test('createLogger escribe una línea JSON por evento y un valor hostil no puede partirla', () => {
  const lines = []; const log = createLogger({ level: 'info', instanceId: 'i1', sink: l => lines.push(l) });
  log.warn('evento', { origin: 'https://evil.example\n{"level":"fatal","msg":"falso"}', note: 'Bearer abcdefghijklmnop' });
  assert.equal(lines.length, 1); assert.ok(!lines[0].includes('\n')); const rec = JSON.parse(lines[0]);
  assert.equal(rec.msg, 'evento'); assert.ok(!rec.origin.includes('\n')); assert.ok(!rec.note.includes('abcdefghijklmnop'));
  log.debug('no se escribe', {}); assert.equal(lines.length, 1, 'respeta el nivel');
  const child = log.child({ connId: 'c1' }); child.info('hijo', { x: 1 }); assert.equal(JSON.parse(lines[1]).connId, 'c1');
});

test('en el servidor real: el login fallido registra la IP normalizada, nunca la contraseña, y una cabecera X-Forwarded-For hostil no entra a los logs', async t => {
  const srv = await startServer({ trustProxyHops: 1, logLevel: 'info' }); t.after(srv.stop);
  await http(srv.base, 'POST', '/api/master/login', { body: { password: 'esta-no-es-la-clave-123' }, headers: { 'x-forwarded-for': '2001:db8:7:7:1:2:3:4' } });
  await http(srv.base, 'POST', '/api/master/login', { body: { password: 'otra-mala-456' }, headers: { 'x-forwarded-for': '</script>{"level":"fatal","msg":"falso"}' } });
  const all = srv.logs.join('\n');
  assert.ok(!all.includes('esta-no-es-la-clave-123') && !all.includes('otra-mala-456') && !all.includes(PASSWORD), 'ninguna contraseña en los logs');
  const fails = srv.logs.map(l => JSON.parse(l)).filter(r => r.msg === 'login_failed');
  assert.equal(fails.length, 2); assert.equal(fails[0].ip, '2001:db8:7:7::/64', 'IPv6 registrada como su prefijo /64'); assert.equal(fails[1].ip, '127.0.0.1', 'basura → IP del socket');
  assert.ok(!all.includes('</script>'), 'el contenido hostil no se vuelca');
  for (const l of srv.logs) assert.doesNotThrow(() => JSON.parse(l), 'cada línea es JSON válido');
});
