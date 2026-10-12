'use strict';
// Empaquetado de releases (V3.5.0): el ZIP no puede arrastrar secretos ni archivos locales. Se crean archivos SEÑUELO sensibles en un proyecto temporal y se
// comprueba que NO aparecen en el ZIP, que lo necesario SÍ, que un secreto dentro de un archivo permitido aborta sin tocar nada y que el repositorio real está limpio.
// Los valores sensibles de prueba se arman en tiempo de ejecución (partes concatenadas) para que este archivo no contenga secretos «de verdad».
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('../tools/release');

const APP = path.join(__dirname, '..');
const MARKER = 'DECOY_VALOR_SECRETO_' + 'c7e19a';                        // texto único que no debe aparecer jamás dentro del ZIP
const PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const GH = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';          // 36 caracteres tras el prefijo
const NPM = 'npm' + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const AWS = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
const SLACK = 'xox' + 'b-' + '1234567890-abcdefghij';
const GOOG = 'AI' + 'za' + 'SyA1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q';
const STRIPE = 'sk_' + 'live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2';

function write(dir, rel, content = 'x') { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); }
function makeProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-rel-app-')); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-rel-out-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); });
  write(dir, 'package.json', '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n');
  write(dir, 'package-lock.json', '{\n  "name": "demo",\n  "version": "1.0.0",\n  "packages": { "": { "name": "demo", "version": "1.0.0" } }\n}\n');
  write(dir, 'README.md', '# Destello·Sync V1.0.0\n'); write(dir, 'CHANGELOG.md', '# Historial\n\n' + R.MARK + '\n\n## [1.0.0] — 2026-01-01\n\n- inicial\n');
  write(dir, 'server.js', "'use strict';\n"); write(dir, 'src/app.js', '// app\n'); write(dir, 'src/config.js', '// config\n'); write(dir, 'src/auth.js', '// auth\n');
  write(dir, 'public/master.html', '<html></html>'); write(dir, 'scripts/check-syntax.js', 'process.exit(0);\n'); write(dir, 'docs/guia.md', '# guía\n'); write(dir, 'test/a.test.js', '// t\n');
  write(dir, '.gitignore', '.env\n.env.*\n!.env.example\ndocs/ignorado-por-git.md\n'); write(dir, '.env.example', '# MASTER_PASSWORD=una-contraseña-larga-de-al-menos-12-caracteres\n# METRICS_TOKEN=token-para-prometheus\n');
  return { dir, out };
}
const addDecoys = dir => {
  const files = ['.env', '.env.production', '.env.local', '.npmrc', 'id_rsa', 'server.pem', 'private.key', 'backup.sql', 'data.sqlite', 'dump.rdb', 'debug.log', 'notes.bak', 'src/secrets.json', 'src/.env',
    'docs/credentials.md', '.DS_Store', 'Thumbs.db', '.vscode/settings.json', 'node_modules/x/index.js', '.git/config', 'public/app.js.tmp', 'public/app.js~', 'backup.zip', 'local-notes/ideas.md',
    'v12-salida.txt', 'public/index.html.artifact.json', 'credentials.json', 'config.local.json', 'src/cert.crt', 'public/llave.pfx', 'docs/volcado.dump'];
  for (const f of files) write(dir, f, 'valor=' + MARKER + '\n' + (f === '.npmrc' ? '//registry.npmjs.org/:_authToken=' + NPM + '\n' : ''));
  return files;
};
const names = zipPath => R.readZip(fs.readFileSync(zipPath)).map(e => e.name.replace(/^DestelloSync-Render\//, ''));
const snapshot = dir => Object.fromEntries(['package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md'].map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

test('señuelos sensibles: .env y variantes, .npmrc con token, claves, certificados, volcados, logs, copias, temporales y carpetas locales NO entran en el ZIP; lo necesario sí', t => {
  const { dir, out } = makeProject(t); const decoys = addDecoys(dir);
  const r = R.run(['patch', '--nota', 'prueba', '--out', out], { appDir: dir, useGit: false });
  assert.equal(r.old, '1.0.0'); assert.equal(r.next, '1.0.1'); assert.equal(r.signature, '504b0304');
  const got = names(r.zipPath);
  for (const d of decoys) assert.ok(!got.includes(d), 'no debe estar en el ZIP: ' + d);
  for (const need of [...R.REQUIRED, '.env.example', '.gitignore', 'docs/guia.md', 'test/a.test.js', 'scripts/check-syntax.js']) assert.ok(got.includes(need), 'debe estar en el ZIP: ' + need);
  for (const e of R.readZip(fs.readFileSync(r.zipPath))) { assert.ok(!e.data.includes(MARKER), 'el valor de un señuelo apareció dentro de ' + e.name); assert.ok(!e.data.includes(NPM), 'el token del .npmrc apareció en ' + e.name); }
  assert.ok(r.excluded >= 20, 'se informan las exclusiones: ' + r.excluded);
});

test('con Git: lo que .gitignore deja fuera tampoco entra (aunque esté en una raíz permitida); sin Git entra solo si no lo frena otro filtro', t => {
  const git = spawnSync('git', ['--version']); if (git.status !== 0) return t.skip('git no disponible');
  const { dir, out } = makeProject(t); write(dir, 'docs/ignorado-por-git.md', '# local\n'); write(dir, 'docs/nuevo-sin-versionar.md', '# nuevo\n');
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
  const conGit = R.run(['patch', '--nota', 'a', '--out', out], { appDir: dir, useGit: true }); const g = names(conGit.zipPath);
  assert.equal(conGit.mode, 'git'); assert.ok(!g.includes('docs/ignorado-por-git.md'), 'ignorado por Git: fuera'); assert.ok(g.includes('docs/nuevo-sin-versionar.md'), 'nuevo y no ignorado: entra (la primera versión de un archivo no puede perderse)');
  const { dir: d2, out: o2 } = makeProject(t); write(d2, 'docs/ignorado-por-git.md', '# local\n');
  const sinGit = R.run(['patch', '--nota', 'a', '--out', o2], { appDir: d2, useGit: false }); assert.equal(sinGit.mode, 'carpeta'); assert.ok(names(sinGit.zipPath).includes('docs/ignorado-por-git.md'), 'sin Git no hay .gitignore que consultar: los demás filtros siguen aplicando');
});

test('un secreto dentro de un archivo PERMITIDO aborta la versión sin crear el ZIP ni modificar ningún archivo, y el error no repite el valor', t => {
  for (const [label, content, rule] of [['clave privada', PEM + '\nMIIE\n', 'clave-privada'], ['token de GitHub', 'const t = "' + GH + '";\n', 'github-token'], ['clave de AWS', '# ' + AWS + '\n', 'aws-access-key'],
    ['asignación de secreto en código', 'const MASTER_PASSWORD = "hunter2hunter2hunter2";\n', 'asignacion-de-secreto'], ['URL con credenciales', 'const u = "postgres://admin:Sup3rClave@db.interno.example/app";\n', 'url-con-credenciales']]) {
    const { dir, out } = makeProject(t); write(dir, 'src/fuga.js', 'a\nb\n' + content); const before = snapshot(dir);
    let err; try { R.run(['minor', '--nota', 'x', '--out', out], { appDir: dir, useGit: false }); } catch (e) { err = e; }
    assert.ok(err, label + ': debía abortar'); assert.match(err.message, /src\/fuga\.js:3 \(/, label); assert.ok(err.message.includes(rule), label + ' → regla ' + rule + ': ' + err.message);
    for (const v of [PEM, GH, AWS, 'hunter2hunter2hunter2', 'Sup3rClave']) assert.ok(!err.message.includes(v), label + ': el mensaje no debe repetir el secreto');
    assert.deepEqual(fs.readdirSync(out), [], label + ': no se creó ningún ZIP'); assert.deepEqual(snapshot(dir), before, label + ': ningún archivo modificado');
  }
});

test('archivos DENEGADOS que contienen secretos no abortan (simplemente se excluyen); documentación, pruebas y ejemplos con valores de muestra tampoco', t => {
  const { dir, out } = makeProject(t);
  write(dir, '.npmrc', '//registry.npmjs.org/:_authToken=' + NPM + '\n'); write(dir, '.env', 'TOKEN_SECRET=' + 'z'.repeat(40) + '\n'); write(dir, 'src/secrets.json', '{"k":"' + GH + '"}');
  write(dir, 'docs/guia.md', 'MASTER_PASSWORD=ejemplo-de-contrasena-larga\nredis://usuario:clave-de-ejemplo@host\n'); write(dir, 'test/fixture.js', "const url = 'redis://:sup3r-s3cr3t-pass@127.0.0.1:6379';\nconst MASTER_PASSWORD = 'password-de-prueba-123';\n");
  write(dir, 'server.js', "process.env.MASTER_PASSWORD = require('crypto').randomBytes(9).toString('base64url');\n"); write(dir, 'src/ok.js', "const pw = env.MASTER_PASSWORD || '';\n// MASTER_PASSWORD=<la-define-el-operador>\n");
  const r = R.run(['patch', '--nota', 'a', '--out', out], { appDir: dir, useGit: false }); const got = names(r.zipPath);
  for (const f of ['.npmrc', '.env', 'src/secrets.json']) assert.ok(!got.includes(f), f);
  for (const f of ['docs/guia.md', 'test/fixture.js', 'server.js', 'src/ok.js', '.env.example']) assert.ok(got.includes(f), f);
});

test('si falta un archivo necesario para ejecutar la aplicación, la versión se rechaza; si el destino no se puede escribir, no queda nada modificado', t => {
  const a = makeProject(t); fs.rmSync(path.join(a.dir, 'src/auth.js'));
  assert.throws(() => R.run(['patch', '--nota', 'x', '--out', a.out], { appDir: a.dir, useGit: false }), /Faltan en el paquete.*src\/auth\.js/);
  const b = makeProject(t); const before = snapshot(b.dir); const notADir = path.join(b.out, 'es-un-archivo'); fs.writeFileSync(notADir, 'x');
  assert.throws(() => R.run(['patch', '--nota', 'x', '--out', notADir], { appDir: b.dir, useGit: false }));
  assert.deepEqual(snapshot(b.dir), before, 'el destino inválido no deja la versión a medias'); assert.deepEqual(fs.readdirSync(b.out), ['es-un-archivo']);
  const c = makeProject(t); const r = R.run(['patch', '--nota', 'x', '--dry-run', '--out', c.out], { appDir: c.dir, useGit: false });
  assert.equal(r.dry, true); assert.deepEqual(fs.readdirSync(c.out), []); assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir, 'package.json'), 'utf8')).version, '1.0.0');
});

test('versión nueva: package.json, package-lock.json (2 apariciones), README y CHANGELOG se actualizan juntos y el ZIP contiene esos mismos contenidos', t => {
  const { dir, out } = makeProject(t); const r = R.run(['minor', '--nota', 'cambio uno', '--nota', 'cambio dos', '--out', out], { appDir: dir, useGit: false });
  assert.equal(r.next, '1.1.0'); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '1.1.0');
  assert.equal((fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8').match(/"version": "1\.1\.0"/g) || []).length, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# Destello·Sync V1.1.0\n');
  const cl = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'); assert.ok(cl.indexOf('## [1.1.0]') > cl.indexOf(R.MARK) && cl.indexOf('## [1.1.0]') < cl.indexOf('## [1.0.0]') && cl.includes('- cambio uno\n- cambio dos'));
  for (const e of R.readZip(fs.readFileSync(r.zipPath))) { const rel = e.name.replace(/^DestelloSync-Render\//, ''); if (['package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md'].includes(rel)) assert.equal(e.data.toString('utf8'), fs.readFileSync(path.join(dir, rel), 'utf8'), rel + ' dentro del ZIP = en disco'); }
  const existing = path.join(out, 'DestelloSync-V1.1.1-Render.zip'); fs.writeFileSync(existing, 'zip previo del usuario');            // el siguiente parche (1.1.1) ya tendría ZIP
  assert.throws(() => R.run(['patch', '--nota', 'x', '--out', out], { appDir: dir, useGit: false }), /Ya existe/, 'no sobrescribe un ZIP existente sin --force');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'zip previo del usuario', 'el archivo del usuario queda intacto'); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '1.1.0');
});

test('scanForSecrets: reconoce los formatos habituales, informa archivo/línea/regla y NUNCA el valor; el texto corriente y los marcadores de ejemplo no se marcan', () => {
  const cases = [[PEM, 'clave-privada'], [GH, 'github-token'], [NPM, 'npm-token'], [AWS, 'aws-access-key'], [SLACK, 'slack-token'], [GOOG, 'google-api-key'], [STRIPE, 'stripe-live-key'], ['//registry.npmjs.org/:_authToken=' + NPM.slice(0, 20), 'npmrc-authtoken']];
  for (const [secret, rule] of cases) {
    const found = R.scanForSecrets('docs/x.md', Buffer.from('línea 1\nvalor: ' + secret + '\n')); assert.deepEqual(found.map(f => [f.line, f.rule]), [[2, rule]], rule);
    assert.ok(!JSON.stringify(found).includes(secret.slice(5)), 'el resultado no contiene el valor');
  }
  const fine = 'texto normal, MASTER_PASSWORD=<la define el operador>, TOKEN_SECRET=ejemplo-de-clave-larga, redis://127.0.0.1:6379, ' + 'a'.repeat(50);
  assert.deepEqual(R.scanForSecrets('src/x.js', Buffer.from(fine)), []);
  assert.deepEqual(R.scanForSecrets('public/logo.png', Buffer.from(PEM)), [], 'los binarios no se escanean como texto');
});

test('denyReason: tabla de nombres sensibles y legítimos', () => {
  for (const bad of ['.env', '.env.production', '.env.local', 'src/.env', '.npmrc', 'id_rsa', 'id_ed25519.pub', 'a/server.pem', 'k.key', 'x.p12', 'x.pfx', 'x.sql', 'x.sqlite3', 'x.dump', 'x.rdb', 'x.log', 'x.bak', 'x.tmp', 'x.swp', 'x.zip', 'x.tgz',
    'credentials.json', 'secrets.yaml', 'prod.secrets.json', 'service-account-prod.json', 'terraform.tfvars', 'a.tfstate', '.DS_Store', 'Thumbs.db', 'v12-salida.txt', 'public/a.html.artifact.json', 'node_modules/a/b.js', '.git/config', '.vscode/s.json', '.claude/x.md', 'a~'])
    assert.ok(R.denyReason(bad), 'debe denegarse: ' + bad);
  for (const ok of ['.env.example', 'src/app.js', 'public/js/master.js', 'docs/SEGURIDAD.md', 'package.json', 'package-lock.json', 'render.yaml', 'public/icons/icon-192.png', 'loadtest-results/100.json', '.gitignore', 'test/seguridad.test.js'])
    assert.equal(R.denyReason(ok), null, 'debe permitirse: ' + ok);
});

test('el repositorio REAL cumple su propia política: ningún archivo del paquete contiene secretos, lo necesario está y no entra nada sensible', () => {
  const sel = R.collect(APP);
  for (const need of R.REQUIRED) assert.ok(sel.files.includes(need), need);
  const found = []; for (const f of sel.files) found.push(...R.scanForSecrets(f, fs.readFileSync(path.join(APP, f))));
  assert.deepEqual(found, [], 'hallazgos de secretos en el paquete real: ' + JSON.stringify(found));
  assert.ok(!sel.files.some(f => /(^|\/)\.env($|\.)(?!example)/.test(f) || /\.(pem|key|sql|log|bak|tmp)$/.test(f)), 'sin archivos sensibles por nombre');
  assert.deepEqual(sel.skippedTop, [], 'nada del proyecto queda fuera de las raíces permitidas sin que lo sepamos: ' + sel.skippedTop.join(', '));
});
