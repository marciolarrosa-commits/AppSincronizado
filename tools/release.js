'use strict';
// Versionado de cada modificación: sube la versión, registra la nota en CHANGELOG.md y genera el ZIP del paquete.
//   node tools/release.js <patch|minor|major> --nota "qué cambió" [--nota "otra"] [--out DIR] [--dry-run] [--force]
// Antes de tocar nada ejecuta la verificación de sintaxis y exige al menos una nota (cada versión queda documentada).
// Actualiza: package.json, package-lock.json, el título del README y CHANGELOG.md. El ZIP (DestelloSync-V<versión>-Render.zip) es un ZIP real
// (no un tar): se escribe con zlib, sin dependencias, sin node_modules, .git, *.artifact.json ni salidas de pruebas (v<n>*.txt), y se relee para verificarlo.
// No hace commit, push ni despliegue.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const PREFIX = 'DestelloSync-Render/';
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_FILE = /^v\d+.*\.txt$|\.artifact\.json$/;
const MARK = '<!-- release:next -->';

function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error('Versión no válida: ' + version);
  let [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') { a++; b = 0; c = 0; } else if (kind === 'minor') { b++; c = 0; } else if (kind === 'patch') c++;
  else throw new Error('Tipo de versión desconocido (patch|minor|major): ' + kind);
  return `${a}.${b}.${c}`;
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...listFiles(dir, r)); } else if (e.isFile() && !SKIP_FILE.test(e.name)) out.push(r);
  }
  return out;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

/** Construye un ZIP (método deflate, nombres UTF-8) con [{name, data:Buffer}]. */
function makeZip(entries, date = new Date()) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals = []; const centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'); const raw = e.data; const def = zlib.deflateRawSync(raw, { level: 9 });
    const useDef = def.length < raw.length; const body = useDef ? def : raw; const method = useDef ? 8 : 0; const crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); centrals.push(ch, name); offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Lee un ZIP y comprueba el CRC de cada entrada: devuelve [{name, data}]. Lanza si el archivo no es un ZIP válido. */
function readZip(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('No es un ZIP (sin registro final)');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Directorio central dañado');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl); const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const body = buf.subarray(ds, ds + csize); const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    if (crc32(data) !== crc) throw new Error('CRC incorrecto en ' + name);
    out.push({ name, data }); p += 46 + nl + xl + cl;
  }
  return out;
}

function today(d = new Date()) { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }

function changelogEntry(version, notes, date) { return `## [${version}] — ${date}\n\n${notes.map(n => '- ' + n).join('\n')}\n`; }

function parseArgs(argv) {
  const o = { kind: null, notes: [], out: path.join(APP, '..', '..'), dry: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--nota') o.notes.push(String(argv[++i] || '').trim()); else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--dry-run') o.dry = true; else if (a === '--force') o.force = true; else if (!a.startsWith('--') && !o.kind) o.kind = a;
    else throw new Error('Argumento desconocido: ' + a);
  }
  return o;
}

function run(argv) {
  const o = parseArgs(argv);
  if (!o.kind) throw new Error('Uso: node tools/release.js <patch|minor|major> --nota "qué cambió" [--nota …] [--out DIR] [--dry-run] [--force]');
  const notes = o.notes.filter(Boolean);
  if (!notes.length) throw new Error('Falta --nota: cada versión debe quedar documentada en CHANGELOG.md.');
  const pkgPath = path.join(APP, 'package.json'); const pkgText = fs.readFileSync(pkgPath, 'utf8');
  const old = JSON.parse(pkgText).version; const next = bump(old, o.kind);
  const zipPath = path.join(o.out, `DestelloSync-V${next}-Render.zip`);
  if (fs.existsSync(zipPath) && !o.force) throw new Error('Ya existe ' + zipPath + ' (use --force para reemplazarlo).');
  const chk = spawnSync(process.execPath, [path.join(APP, 'scripts', 'check-syntax.js')], { encoding: 'utf8' });
  if (chk.status !== 0) throw new Error('La verificación de sintaxis falló; no se genera la versión:\n' + chk.stdout + chk.stderr);
  const clPath = path.join(APP, 'CHANGELOG.md'); const cl = fs.readFileSync(clPath, 'utf8');
  if (!cl.includes(MARK)) throw new Error('CHANGELOG.md no tiene la marca ' + MARK);
  const lockPath = path.join(APP, 'package-lock.json'); const readmePath = path.join(APP, 'README.md');
  const lock = fs.readFileSync(lockPath, 'utf8'); const readme = fs.readFileSync(readmePath, 'utf8');
  const needle = `"version": "${old}"`;
  let seen = 0; const lock2 = lock.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), m => (++seen <= 2 ? `"version": "${next}"` : m));
  const files = {
    [pkgPath]: pkgText.replace(needle, `"version": "${next}"`),
    [lockPath]: lock2,
    [readmePath]: readme.replace(/^# Destello·Sync V\d+\.\d+\.\d+/, '# Destello·Sync V' + next),
    [clPath]: cl.replace(MARK, MARK + '\n\n' + changelogEntry(next, notes, today()).trimEnd())
  };
  if (o.dry) return { old, next, zipPath, dry: true };
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(f, text);
  const entries = listFiles(APP).map(r => ({ name: PREFIX + r, data: fs.readFileSync(path.join(APP, r)) }));
  fs.mkdirSync(o.out, { recursive: true }); const zip = makeZip(entries); fs.writeFileSync(zipPath, zip);
  const back = readZip(fs.readFileSync(zipPath));
  if (back.length !== entries.length) throw new Error('El ZIP releído no coincide con lo escrito');
  return { old, next, zipPath, files: entries.length, bytes: zip.length, signature: zip.subarray(0, 4).toString('hex') };
}

module.exports = { bump, listFiles, makeZip, readZip, crc32, changelogEntry, today, run, MARK };

if (require.main === module) {
  try { const r = run(process.argv.slice(2)); console.log(r.dry ? `(simulación) ${r.old} → ${r.next}: ${r.zipPath}` : `versión ${r.old} → ${r.next}\nZIP: ${r.zipPath}\narchivos: ${r.files} · bytes: ${r.bytes} · firma: ${r.signature}\nNo se hizo commit, push ni despliegue.`); }
  catch (e) { console.error(e.message); process.exit(1); }
}
