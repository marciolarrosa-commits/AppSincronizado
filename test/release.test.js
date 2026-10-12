'use strict';
// Versionado: cálculo de versiones, ZIP real (escritura y relectura con CRC), exclusiones del paquete y registro obligatorio en CHANGELOG.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('../tools/release');

const APP = path.join(__dirname, '..');

test('bump: parche, menor y mayor reinician los dígitos de la derecha; entradas inválidas se rechazan', () => {
  assert.equal(R.bump('3.4.1', 'patch'), '3.4.2'); assert.equal(R.bump('3.4.1', 'minor'), '3.5.0'); assert.equal(R.bump('3.4.1', 'major'), '4.0.0');
  assert.equal(R.bump('3.9.9', 'patch'), '3.9.10');
  assert.throws(() => R.bump('3.4', 'patch')); assert.throws(() => R.bump('3.4.1', 'otro'));
});

test('ZIP: empieza con la firma PK, relee todo con CRC correcto (texto, binario incompresible y vacío, nombres con tildes) y detecta datos alterados', () => {
  const bin = crypto.randomBytes(4096);
  const entries = [{ name: 'A/leeme.txt', data: Buffer.from('hola '.repeat(500)) }, { name: 'A/ñandú-ü.bin', data: bin }, { name: 'A/vacío.txt', data: Buffer.alloc(0) }];
  const zip = R.makeZip(entries);
  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304', 'firma de ZIP (no tar)');
  const back = R.readZip(zip);
  assert.deepEqual(back.map(e => e.name), entries.map(e => e.name));
  back.forEach((e, i) => assert.ok(e.data.equals(entries[i].data), e.name));
  assert.ok(zip.length < 4096 + 2600 + 1000, 'el texto repetitivo se comprime');
  const bad = Buffer.from(zip); const at = bad.indexOf(bin.subarray(0, 16)); bad[at] ^= 0xFF;
  assert.throws(() => R.readZip(bad), /CRC/);
  assert.throws(() => R.readZip(Buffer.from('esto es un tar, no un zip'.repeat(5))), /ZIP/);
});

test('paquete: incluye el código y excluye node_modules, .git, metadatos del editor y salidas de pruebas', () => {
  const files = R.listFiles(APP);
  for (const f of ['package.json', 'CHANGELOG.md', 'server.js', 'src/app.js', 'tools/release.js']) assert.ok(files.includes(f), f);
  assert.ok(!files.some(f => /(^|\/)(node_modules|\.git)\//.test(f)), 'sin node_modules ni .git');
  assert.ok(!files.some(f => /\.artifact\.json$/.test(f)) && !files.some(f => /^v\d+.*\.txt$/.test(path.basename(f))));
  assert.ok(files.every(f => !f.includes(String.fromCharCode(92))), 'rutas con «/»');
});

test('CHANGELOG: tiene la marca de inserción y la versión actual de package.json ya figura registrada', () => {
  const cl = fs.readFileSync(path.join(APP, 'CHANGELOG.md'), 'utf8'); const v = require('../package.json').version;
  assert.ok(cl.includes(R.MARK)); assert.ok(cl.includes('## [' + v + ']'), 'la versión ' + v + ' está en CHANGELOG.md');
  assert.ok(cl.indexOf(R.MARK) < cl.indexOf('## [' + v + ']'), 'las versiones nuevas se insertan arriba');
  assert.match(R.changelogEntry('9.9.9', ['a', 'b'], '2026-01-02'), /^## \[9\.9\.9\] — 2026-01-02\n\n- a\n- b\n$/);
});

test('release.run: exige una nota, rechaza tipos desconocidos y en simulación no modifica ningún archivo', () => {
  const pk = fs.readFileSync(path.join(APP, 'package.json'), 'utf8'); const cl = fs.readFileSync(path.join(APP, 'CHANGELOG.md'), 'utf8');
  assert.throws(() => R.run(['patch']), /--nota/);
  assert.throws(() => R.run(['--nota', 'x']), /Uso/);
  assert.throws(() => R.run(['raro', '--nota', 'x', '--dry-run']), /desconocido/);
  const r = R.run(['patch', '--nota', 'prueba', '--dry-run', '--out', path.join(APP, 'no-se-crea')]);
  assert.equal(r.dry, true); assert.equal(r.next, R.bump(r.old, 'patch'));
  assert.equal(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'), pk); assert.equal(fs.readFileSync(path.join(APP, 'CHANGELOG.md'), 'utf8'), cl);
  assert.ok(!fs.existsSync(path.join(APP, 'no-se-crea')));
});
