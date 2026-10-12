'use strict';
// Autenticación (V3.5.0): validación del secreto de firma, reclamaciones de los tokens, rotación de contraseña/secreto, revocación y que nada filtre el secreto.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createAuth, validateTokenSecret, deriveSecretFromPassword, MAX_LIFETIME_S } = require('../src/auth');
const { loadConfig } = require('../src/config');

const SECRET = crypto.randomBytes(48);
const cfg = (over = {}) => ({ tokenSecret: SECRET, masterPassword: 'Xk9f-Qw3z-Lm82-Pa7d', operatorTokenTtlS: 600, masterTokenTtlS: 600, ...over });
const b64 = b => Buffer.from(b).toString('base64url');
// Firma un payload arbitrario con el secreto de prueba (para fabricar tokens malformados que el servidor jamás emitiría)
function forge(payload, secret = SECRET) { const body = b64(JSON.stringify(payload)); return body + '.' + b64(crypto.createHmac('sha256', secret).update(body).digest()); }
const now = () => Math.floor(Date.now() / 1000);
function goodClaims(auth, over = {}) {
  const p = JSON.parse(Buffer.from(auth.issueOperatorToken().token.split('.')[0], 'base64url').toString());
  return { ...p, ...over };
}

test('TOKEN_SECRET explícito: solo se acepta una representación (hex / base64 / base64url) de ≥ 32 bytes aleatorios; texto libre, cortos y patrones se rechazan', () => {
  assert.equal(validateTokenSecret(crypto.randomBytes(32).toString('hex')).length, 32);
  assert.equal(validateTokenSecret(crypto.randomBytes(32).toString('base64')).length, 32, 'el formato que genera generateValue de Render (256 bits en base64)');
  assert.equal(validateTokenSecret(crypto.randomBytes(48).toString('base64url')).length, 48);
  // el validador no rechaza secretos aleatorios legítimos (medido: 0 de 20 000 por formato); aquí, 2 000 de cada uno
  for (let i = 0; i < 2000; i++) { validateTokenSecret(crypto.randomBytes(32).toString('hex')); validateTokenSecret(crypto.randomBytes(32).toString('base64')); validateTokenSecret(crypto.randomBytes(48).toString('base64url')); }
  const weak = ['corto', 'a'.repeat(64), '0'.repeat(64), '0123456789abcdef'.repeat(4), 'abcdefgh'.repeat(8), 'palabralargasinmezclaperosuficientementelargapara', 'elmurcielagoveloz-hindu-comia-feliz-cardillo-y-kiwi',
    'Fq7#zK2!mP9$wL4&xN8*vB3^cR6@tY1%hJ5(gD0)', 'Contrasena-Muy-Larga-De-Mi-Empresa-2026-OK!', ' ' + crypto.randomBytes(32).toString('hex'), crypto.randomBytes(16).toString('hex'), crypto.randomBytes(24).toString('base64'), ''];
  for (const w of weak) assert.throws(() => validateTokenSecret(w), /TOKEN_SECRET/, JSON.stringify(w.slice(0, 20)));
});

test('TOKEN_SECRET inválido aborta el arranque con un mensaje claro que NO incluye el valor configurado', () => {
  for (const bad of ['sencillo-pero-largo-0123456789abcdef-sencillo-pero', 'x'.repeat(40)]) {
    try { loadConfig({ TOKEN_SECRET: bad }); assert.fail('debía lanzar'); }
    catch (e) { assert.match(e.message, /TOKEN_SECRET/); assert.ok(!e.message.includes(bad), 'el error no repite el secreto'); }
  }
  const good = crypto.randomBytes(48).toString('base64url');
  const c = loadConfig({ TOKEN_SECRET: good }); assert.equal(c.tokenSecretSource, 'env'); assert.ok(Buffer.isBuffer(c.tokenSecret) && c.tokenSecret.length >= 32);
  assert.ok(!JSON.stringify(Object.keys(c)).includes(good), 'el secreto no se usa como nombre de campo');
});

test('sin TOKEN_SECRET el secreto se deriva de la contraseña con scrypt (lento, determinista y distinto del anterior HKDF)', () => {
  const t0 = process.hrtime.bigint(); const a = deriveSecretFromPassword('Xk9f-Qw3z-Lm82-Pa7d'); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(a.length, 32); assert.ok(a.equals(deriveSecretFromPassword('Xk9f-Qw3z-Lm82-Pa7d')), 'determinista: todas las instancias coinciden');
  assert.ok(!a.equals(deriveSecretFromPassword('Xk9f-Qw3z-Lm82-Pa7e')));
  const oldHkdf = Buffer.from(crypto.hkdfSync('sha256', 'Xk9f-Qw3z-Lm82-Pa7d', 'destello-sync', 'token-secret-v1', 32));
  assert.ok(!a.equals(oldHkdf), 'ya no es el HKDF rápido anterior');
  assert.ok(ms >= 10, `scrypt debe costar tiempo real (medido ${ms.toFixed(1)} ms): cada intento de adivinar la contraseña desde un token tiene ese costo`);
});

test('tokens: emitidos llevan versión, emisión, vencimiento, identificador y huella de contraseña; el rol y la sesión se comprueban', () => {
  const auth = createAuth(cfg());
  const op = auth.issueOperatorToken(); const p = auth.verifyOperator(op.token);
  assert.ok(p && p.v === 1 && p.r === 'op' && Number.isSafeInteger(p.iat) && p.exp - p.iat === 600 && /^[0-9a-f]{12}$/.test(p.jti) && typeof p.pf === 'string' && p.g === 0);
  assert.equal(op.expiresAt, p.exp * 1000);
  const ma = auth.issueMasterToken('ABC234', 3);
  assert.equal(auth.verifyMaster(ma.token, 'ABC234').ep, 3);
  assert.equal(auth.verifyMaster(ma.token, 'ZZZ999'), null, 'un token de Master solo sirve para SU sesión');
  assert.equal(auth.verifyOperator(ma.token), null, 'un token de Master NO sirve como operador (no hay elevación de privilegios)');
  assert.equal(auth.verifyMaster(op.token, 'ABC234'), null, 'un token de operador NO se acepta como Master de una sesión');
});

test('tokens: firma y estructura — manipulados, truncados, con partes de más, caracteres ajenos, demasiado largos y no cadenas se rechazan', () => {
  const auth = createAuth(cfg()); const t = auth.issueOperatorToken().token; const [body, sig] = t.split('.');
  const flip = s => s.slice(0, -2) + (s.endsWith('A') ? 'B' : 'A') + s.slice(-1);
  const cases = [flip(body) + '.' + sig, body + '.' + flip(sig), body, body + '.', '.' + sig, t + '.extra', t + '=', 'a b.' + sig, body + '.' + sig.slice(0, -4), t + 'x'.repeat(700), '', null, undefined, 12345, {}, ['x']];
  for (const c of cases) assert.equal(auth.verifyOperator(c), null, String(c).slice(0, 40));
  // «alg: none»-style: sin firma o con firma vacía
  assert.equal(auth.verifyOperator(body + '.'), null);
});

test('tokens: reclamaciones inválidas firmadas con el secreto correcto también se rechazan (rol, tipos, vencimiento, emisión futura, vida máxima, jti, sesión, generación)', () => {
  const auth = createAuth(cfg()); const base = goodClaims(auth);
  assert.ok(auth.verifyOperator(forge(base)), 'control: las reclamaciones base son válidas');
  const bad = {
    'sin versión': { ...base, v: undefined }, 'versión 2': { ...base, v: 2 }, 'rol admin': { ...base, r: 'admin' }, 'rol vacío': { ...base, r: undefined },
    'exp texto': { ...base, exp: String(base.exp) }, 'exp decimal': { ...base, exp: base.exp + 0.5 }, 'exp vencido': { ...base, exp: now() - 1, iat: now() - 100 },
    'iat futuro lejano': { ...base, iat: now() + 3600, exp: now() + 7200 }, 'exp ≤ iat': { ...base, exp: base.iat },
    'vida > 7 días': { ...base, iat: now(), exp: now() + MAX_LIFETIME_S + 10 }, 'sin jti': { ...base, jti: undefined }, 'jti con formato ajeno': { ...base, jti: '../../etc/pass' },
    'huella ajena': { ...base, pf: 'AAAAAAAAAAAAAAAA' }, 'sin huella': { ...base, pf: undefined }, 'sin generación': { ...base, g: undefined }, 'generación negativa': { ...base, g: -1 }
  };
  for (const [name, claims] of Object.entries(bad)) assert.equal(auth.verifyOperator(forge(claims)), null, name);
  const mBase = JSON.parse(Buffer.from(auth.issueMasterToken('ABC234', 1).token.split('.')[0], 'base64url').toString());
  assert.ok(auth.verifyMaster(forge(mBase), 'ABC234'), 'control master');
  for (const [name, claims] of Object.entries({ 'sin sid': { ...mBase, sid: undefined }, 'sid numérico': { ...mBase, sid: 123456 }, 'sin epoch': { ...mBase, ep: undefined }, 'epoch decimal': { ...mBase, ep: 1.5 } }))
    assert.equal(auth.verifyMaster(forge(claims), 'ABC234'), null, name);
  // Sin el secreto no se puede elevar un token: tocar el rol de un token de Master real rompe la firma
  const real = auth.issueMasterToken('ABC234', 1).token; const [mb, ms] = real.split('.');
  const elevated = b64(JSON.stringify({ ...JSON.parse(Buffer.from(mb, 'base64url').toString()), r: 'op', g: 0 })) + '.' + ms;
  assert.equal(auth.verifyOperator(elevated), null, 'cambiar `r` a mano invalida la firma: no hay elevación de privilegios');
});

test('tokens: vencimiento exacto y tolerancia de relojes entre instancias (iat hasta 60 s en el futuro)', t => {
  const auth = createAuth(cfg({ operatorTokenTtlS: 60 })); const tok = auth.issueOperatorToken().token; const real = Date.now();
  assert.ok(auth.verifyOperator(tok));
  let offset = 0; t.mock.method(Date, 'now', () => real + offset);
  offset = 59 * 1000; assert.ok(auth.verifyOperator(tok), 'a los 59 s aún vale');
  offset = 61 * 1000; assert.equal(auth.verifyOperator(tok), null, 'vencido');
  offset = -30 * 1000; assert.ok(auth.verifyOperator(tok), 'emitido 30 s «en el futuro» (otro reloj): tolerado');
  offset = -120 * 1000; assert.equal(auth.verifyOperator(tok), null, 'emitido 120 s en el futuro: rechazado');
});

test('rotación: cambiar MASTER_PASSWORD o TOKEN_SECRET invalida todos los tokens anteriores (aunque el otro valor no cambie)', () => {
  const a = createAuth(cfg()); const op = a.issueOperatorToken().token; const ma = a.issueMasterToken('ABC234', 1).token;
  const samePwNewSecret = createAuth(cfg({ tokenSecret: crypto.randomBytes(48) }));
  assert.equal(samePwNewSecret.verifyOperator(op), null); assert.equal(samePwNewSecret.verifyMaster(ma, 'ABC234'), null);
  const newPwSameSecret = createAuth(cfg({ masterPassword: 'Otra-Contrasena-Larga-77' }));
  assert.equal(newPwSameSecret.verifyOperator(op), null, 'con TOKEN_SECRET fijo, rotar la contraseña ya invalida los tokens (huella)');
  assert.equal(newPwSameSecret.verifyMaster(ma, 'ABC234'), null);
  const sameAll = createAuth(cfg()); assert.ok(sameAll.verifyOperator(op), 'otra instancia con la misma configuración los acepta');
});

test('revocación: un token revocado deja de valer; los demás siguen; la generación invalida los emitidos antes y no los posteriores; lo vencido se descarta', () => {
  const auth = createAuth(cfg()); const t1 = auth.issueOperatorToken().token; const t2 = auth.issueOperatorToken().token;
  const rev = auth.revokeOperatorToken(auth.verifyOperator(t1)); assert.ok(/^[0-9a-f]{12}$/.test(rev.jti) && rev.exp > now());
  assert.equal(auth.verifyOperator(t1), null); assert.ok(auth.verifyOperator(t2));
  auth.setMinGeneration(1); assert.equal(auth.verifyOperator(t2), null, 'cerrar sesión en todos: el emitido antes de la generación 1 ya no vale');
  const t3 = auth.issueOperatorToken().token; assert.ok(auth.verifyOperator(t3), 'uno nuevo (generación 1) vale');
  auth.setMinGeneration(0); assert.equal(auth.generation, 1, 'la generación nunca retrocede');
  // sincronización con el almacenamiento compartido: unión, ignora entradas ilegibles y poda las vencidas
  const other = createAuth(cfg()); const t4 = other.issueOperatorToken().token; const p4 = other.verifyOperator(t4);
  other.syncRevoked([{ jti: p4.jti, exp: p4.exp }, { jti: 'zz', exp: 'x' }, null, { jti: 'aaaaaaaaaaaa', exp: now() - 5 }]);
  assert.equal(other.verifyOperator(t4), null); assert.equal(other.revokedCount, 1, 'solo queda la vigente');
  // un token de Master no se revoca por jti: lo gobierna el epoch de su sesión
  const ma = other.issueMasterToken('ABC234', 1).token; other.syncRevoked([{ jti: JSON.parse(Buffer.from(ma.split('.')[0], 'base64url').toString()).jti, exp: now() + 100 }]);
  assert.ok(other.verifyMaster(ma, 'ABC234'));
});

test('comparación de contraseña: correcta/incorrecta/tipos ajenos/demasiado larga (sin lanzar) y TTL máximo aunque la configuración pida más', () => {
  const auth = createAuth(cfg());
  assert.equal(auth.checkPassword('Xk9f-Qw3z-Lm82-Pa7d'), true); assert.equal(auth.checkPassword('Xk9f-Qw3z-Lm82-Pa7D'), false);
  for (const v of [undefined, null, 5, {}, [], 'x'.repeat(300)]) assert.equal(auth.checkPassword(v), false);
  const long = createAuth(cfg({ operatorTokenTtlS: 99 * 24 * 3600 })); const p = long.verifyOperator(long.issueOperatorToken().token);
  assert.ok(p && p.exp - p.iat === MAX_LIFETIME_S, 'se recorta a la vida máxima');
  assert.equal(loadConfig({}).operatorTokenTtlS, 8 * 3600); assert.equal(loadConfig({ OPERATOR_TOKEN_TTL_S: '999999' }).operatorTokenTtlS, 24 * 3600, 'tope de 24 h en la configuración');
});
