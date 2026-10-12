'use strict';
// Versionado de cada modificación: sube la versión, registra la nota en CHANGELOG.md y genera el ZIP del paquete.
//   node tools/release.js <patch|minor|major> --nota "qué cambió" [--nota "otra"] [--out DIR] [--dry-run] [--force]
// Antes de tocar nada ejecuta la verificación de sintaxis, exige al menos una nota y revisa QUÉ se va a empaquetar (ver «Política del paquete»). Todo se prepara en
// memoria y solo se escribe al final: si algo falla (secreto detectado, ZIP que no se puede releer…) NO se modifica ningún archivo ni se deja un ZIP a medias.
// Actualiza: package.json, package-lock.json, el título del README y CHANGELOG.md. El ZIP (DestelloSync-V<versión>-Render.zip) es un ZIP real (no un tar), escrito
// con zlib sin dependencias, y se relee verificando el CRC de cada archivo. No hace commit, push ni despliegue.
//
// POLÍTICA DEL PAQUETE (qué entra en el ZIP) — cuatro filtros, TODOS deben pasar:
//   1. Versionado: si la carpeta está en un repositorio Git, solo entran archivos que Git conoce (versionados o nuevos no ignorados: `git ls-files -co --exclude-standard`).
//      Así nada que `.gitignore` deja fuera (p. ej. `.env`) entra por accidente. Sin Git se recorre la carpeta y se aplican los demás filtros.
//   2. Lista PERMITIDA de raíces: solo las carpetas y archivos de primer nivel de ALLOW_DIRS / ALLOW_ROOT_FILES. Lo nuevo que no esté ahí NO entra y se avisa.
//   3. Lista de DENEGACIÓN (no depende de .gitignore): `.env*` (salvo `.env.example`), `.npmrc` y otros archivos de credenciales, claves/certificados privados,
//      volcados de bases de datos, copias de seguridad, logs, temporales, comprimidos y metadatos locales de editores y del sistema.
//   4. Escaneo de CONTENIDO: si un archivo permitido contiene una clave privada, un token conocido (GitHub, npm, Slack, AWS, Google, Stripe) o una asignación de
//      secreto, la versión se ABORTA y se informa archivo, línea y regla (nunca el valor).
// Límites: la lista de denegación y el escaneo reconocen patrones habituales; NO prueban que no haya un secreto con otro formato. Revisar el diff antes de publicar.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const PREFIX = 'DestelloSync-Render/';
const MARK = '<!-- release:next -->';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const ALLOW_DIRS = ['src', 'public', 'scripts', 'tools', 'test', 'e2e', 'docs', 'loadtest-results'];
const ALLOW_ROOT_FILES = new Set(['server.js', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'render.yaml', '.env.example', '.gitignore', '.gitattributes']);
const REQUIRED = ['server.js', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'src/app.js', 'src/config.js', 'src/auth.js', 'public/master.html'];

// Denegación por nombre de carpeta (cualquier nivel)
const DENY_DIRS = new Set(['node_modules', '.git', '.claude', '.vscode', '.idea', '.ssh', '.aws', '.gnupg', '__pycache__', '.cache', 'coverage']);
// Denegación por nombre de archivo (sin distinguir mayúsculas) y por extensión
const DENY_NAMES = /^(\.env(\..*)?|\.npmrc|\.yarnrc(\.yml)?|\.pnpmrc|\.netrc|\.pypirc|\.htpasswd|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\..*)?|secrets?(\..*)?|.*\.secrets?(\..*)?|service-?account.*\.json|terraform\.tfvars|.*\.tfstate(\..*)?|\.ds_store|thumbs\.db|desktop\.ini|npm-debug\.log.*|yarn-error\.log.*)$/i;
const DENY_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.crt', '.cer', '.der', '.gpg', '.asc', '.kdbx', '.ovpn', '.sql', '.sqlite', '.sqlite3', '.db', '.dump', '.rdb', '.aof',
  '.bak', '.backup', '.old', '.orig', '.tmp', '.temp', '.swp', '.swo', '.log', '.zip', '.tar', '.tgz', '.gz', '.7z', '.rar', '.xz', '.pyc']);

function denyReason(rel) {
  const parts = rel.split('/'); const base = parts[parts.length - 1]; const lower = base.toLowerCase();
  for (const d of parts.slice(0, -1)) if (DENY_DIRS.has(d.toLowerCase())) return 'carpeta excluida (' + d + ')';
  if (lower === '.env.example') return null;
  if (DENY_NAMES.test(base)) return 'archivo sensible o local por nombre';
  const ext = path.extname(lower);
  if (DENY_EXT.has(ext)) return 'extensión excluida (' + ext + ')';
  if (/~$/.test(base) || /^v\d+.*\.txt$/i.test(base) || /\.artifact\.json$/i.test(base)) return 'temporal / salida de pruebas / metadato del editor';
  return null;
}

// Reglas de contenido. `strict`: se aplican a TODOS los archivos del paquete. `generic`: solo a código y configuración (no a pruebas ni documentación, que traen valores de ejemplo).
const SECRET_RULES = [
  { id: 'clave-privada', strict: true, re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/ },
  { id: 'aws-access-key', strict: true, re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', strict: true, re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { id: 'npm-token', strict: true, re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'slack-token', strict: true, re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'google-api-key', strict: true, re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-live-key', strict: true, re: /\bsk_live_[0-9a-zA-Z]{20,}/ },
  { id: 'npmrc-authtoken', strict: true, re: /\/\/[^\s]+\/:_authToken=\S{8,}/ },
  { id: 'asignacion-de-secreto', strict: false, re: /\b(MASTER_PASSWORD|TOKEN_SECRET|METRICS_TOKEN|ADMIN_PASSWORD|API_KEY|SECRET_KEY|PRIVATE_KEY|ACCESS_TOKEN|CLIENT_SECRET|DB_PASSWORD)\s*[:=]\s*["']?(?![<${(\[.]|una-|tu-|ejemplo|example|changeme|xxx|\*{3})[^\s"'#]{12,}/i },
  { id: 'url-con-credenciales', strict: false, re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:[^\s/@'"`]{4,}@(?!127\.0\.0\.1|localhost)[^\s'"`]+/i }
];
const GENERIC_SCAN_ROOTS = new Set(['', 'src', 'public', 'scripts', 'tools']);     // '' = archivos de primer nivel (render.yaml, server.js…)
const TEXT_EXT = new Set(['.js', '.json', '.md', '.yaml', '.yml', '.html', '.css', '.txt', '.svg', '.webmanifest', '.example', '.gitignore', '.gitattributes', '']);

/** Busca secretos en el contenido de un archivo del paquete. Devuelve [{file, line, rule}] — NUNCA el valor encontrado. */
function scanForSecrets(rel, buf) {
  const ext = path.extname(rel).toLowerCase(); if (!TEXT_EXT.has(ext) && !rel.endsWith('.env.example')) return [];
  if (buf.length > 2 * 1024 * 1024) return [];
  const top = rel.includes('/') ? rel.split('/')[0] : '';
  // `.env.example` es un ejemplo por definición: solo se le aplican las reglas de tokens/claves reales
  const rules = SECRET_RULES.filter(r => r.strict || (GENERIC_SCAN_ROOTS.has(top) && rel !== '.env.example'));
  const out = []; const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.length > 4000) return;
    // Líneas de código que LEEN la configuración y comentarios: solo reglas estrictas (un token real sigue detectándose; las asignaciones genéricas no aplican)
    const codeReadsConfig = /process\.env|require\(|\bconfig\.|env\.[A-Z_]+/.test(line); const comment = /^\s*(\/\/|\*|#|<!--)/.test(line);
    for (const r of rules) if (r.re.test(line) && (r.strict || !(codeReadsConfig || comment))) out.push({ file: rel, line: i + 1, rule: r.id });
  });
  return out;
}

function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error('Versión no válida: ' + version);
  let [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') { a++; b = 0; c = 0; } else if (kind === 'minor') { b++; c = 0; } else if (kind === 'patch') c++;
  else throw new Error('Tipo de versión desconocido (patch|minor|major): ' + kind);
  return `${a}.${b}.${c}`;
}

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (!DENY_DIRS.has(e.name.toLowerCase())) out.push(...walk(dir, r)); } else out.push(r);
  }
  return out;
}

/** Archivos que Git conoce en `dir` (versionados + nuevos no ignorados), o null si no hay Git / no es un repositorio. Solo comandos de lectura. */
function gitFiles(dir) {
  try {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8' });
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
    const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return null;
    return new Set(r.stdout.split('\0').filter(Boolean));
  } catch { return null; }
}

/** Aplica la política del paquete. Devuelve { files, excluded:[{path,reason}], skippedTop:[…], mode }. */
function collect(dir, { useGit = true } = {}) {
  const git = useGit ? gitFiles(dir) : null; const files = []; const excluded = []; const skippedTop = new Set();
  for (const rel of walk(dir)) {
    const top = rel.includes('/') ? rel.split('/')[0] : '';
    const allowedRoot = top ? ALLOW_DIRS.includes(top) : ALLOW_ROOT_FILES.has(rel);
    const deny = denyReason(rel);
    let reason = null;
    if (deny) reason = deny;
    else if (!allowedRoot) { reason = 'fuera de las raíces permitidas'; skippedTop.add(top || rel); }
    else if (git && !git.has(rel)) reason = 'ignorado por Git (no versionado)';
    else { let st; try { st = fs.lstatSync(path.join(dir, rel)); } catch { st = null; } if (!st || !st.isFile()) reason = 'no es un archivo regular'; else if (st.size > MAX_FILE_BYTES) reason = 'demasiado grande'; }
    if (reason) excluded.push({ path: rel, reason }); else files.push(rel);
  }
  return { files, excluded, skippedTop: [...skippedTop].sort(), mode: git ? 'git' : 'carpeta' };
}

/** Compatibilidad: lista de rutas relativas que entran en el paquete. */
function listFiles(dir, opts) { return collect(dir, opts).files; }

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

function parseArgs(argv, appDir) {
  const o = { kind: null, notes: [], out: path.join(appDir, '..', '..'), dry: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--nota') o.notes.push(String(argv[++i] || '').trim()); else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--dry-run') o.dry = true; else if (a === '--force') o.force = true; else if (!a.startsWith('--') && !o.kind) o.kind = a;
    else throw new Error('Argumento desconocido: ' + a);
  }
  return o;
}

/** Escribe un archivo de forma atómica (archivo temporal + renombrar): nunca queda a medias. */
function writeAtomic(file, data) { const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }

function run(argv, { appDir = APP, useGit = true } = {}) {
  const o = parseArgs(argv, appDir);
  if (!o.kind) throw new Error('Uso: node tools/release.js <patch|minor|major> --nota "qué cambió" [--nota …] [--out DIR] [--dry-run] [--force]');
  const notes = o.notes.filter(Boolean);
  if (!notes.length) throw new Error('Falta --nota: cada versión debe quedar documentada en CHANGELOG.md.');
  const pkgPath = path.join(appDir, 'package.json'); const pkgText = fs.readFileSync(pkgPath, 'utf8');
  const old = JSON.parse(pkgText).version; const next = bump(old, o.kind);
  const zipPath = path.join(o.out, `DestelloSync-V${next}-Render.zip`);
  if (fs.existsSync(zipPath) && !o.force) throw new Error('Ya existe ' + zipPath + ' (use --force para reemplazarlo).');
  const checker = path.join(appDir, 'scripts', 'check-syntax.js');
  if (fs.existsSync(checker)) {
    const chk = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
    if (chk.status !== 0) throw new Error('La verificación de sintaxis falló; no se genera la versión:\n' + chk.stdout + chk.stderr);
  }
  const clPath = path.join(appDir, 'CHANGELOG.md'); const cl = fs.readFileSync(clPath, 'utf8');
  if (!cl.includes(MARK)) throw new Error('CHANGELOG.md no tiene la marca ' + MARK);
  const lockPath = path.join(appDir, 'package-lock.json'); const readmePath = path.join(appDir, 'README.md');
  const lock = fs.readFileSync(lockPath, 'utf8'); const readme = fs.readFileSync(readmePath, 'utf8');
  const needle = `"version": "${old}"`;
  let seen = 0; const lock2 = lock.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), m => (++seen <= 2 ? `"version": "${next}"` : m));
  const rewritten = new Map([
    ['package.json', pkgText.replace(needle, `"version": "${next}"`)],
    ['package-lock.json', lock2],
    ['README.md', readme.replace(/^# Destello·Sync V\d+\.\d+\.\d+/, '# Destello·Sync V' + next)],
    ['CHANGELOG.md', cl.replace(MARK, MARK + '\n\n' + changelogEntry(next, notes, today()).trimEnd())]
  ]);

  // ---- qué se empaqueta (política del paquete) y revisión de contenido ANTES de escribir nada
  const sel = collect(appDir, { useGit });
  const missing = REQUIRED.filter(f => !sel.files.includes(f));
  if (missing.length) throw new Error('Faltan en el paquete archivos necesarios para ejecutar la aplicación: ' + missing.join(', '));
  const entries = []; const findings = [];
  for (const rel of sel.files) {
    const data = rewritten.has(rel) ? Buffer.from(rewritten.get(rel), 'utf8') : fs.readFileSync(path.join(appDir, rel));
    findings.push(...scanForSecrets(rel, data));
    entries.push({ name: PREFIX + rel, data });
  }
  if (findings.length) throw new Error('Posibles secretos en archivos que irían al paquete; la versión NO se genera y no se modificó nada:\n' +
    findings.slice(0, 20).map(f => `  - ${f.file}:${f.line} (${f.rule})`).join('\n') + '\nRevisar y quitar el secreto (no se muestra su valor). Si es un valor de ejemplo, usar un marcador evidente como <...> o «ejemplo».');
  const zip = makeZip(entries);
  const back = readZip(zip);                                                      // se verifica ANTES de escribir
  if (back.length !== entries.length || back.some((b, i) => b.name !== entries[i].name || !b.data.equals(entries[i].data))) throw new Error('El ZIP releído no coincide con lo preparado');
  const result = { old, next, zipPath, files: entries.length, bytes: zip.length, signature: zip.subarray(0, 4).toString('hex'), mode: sel.mode, excluded: sel.excluded.length, skippedTop: sel.skippedTop };
  if (o.dry) return { ...result, dry: true };

  // ---- escritura (todo lo anterior ya está verificado en memoria). Si algo falla a mitad, se restauran los archivos originales y se borra el ZIP temporal.
  fs.mkdirSync(o.out, { recursive: true });
  const tmpZip = zipPath + '.tmp-' + process.pid; const done = [];
  try {
    fs.writeFileSync(tmpZip, zip);
    for (const [rel, text] of rewritten) { const p = path.join(appDir, rel); const orig = fs.readFileSync(p); writeAtomic(p, text); done.push([p, orig]); }
    fs.renameSync(tmpZip, zipPath);
  } catch (e) {
    for (const [p, orig] of done.reverse()) { try { writeAtomic(p, orig); } catch { /* mejor esfuerzo */ } }
    try { fs.unlinkSync(tmpZip); } catch { /* no llegó a crearse */ }
    throw e;
  }
  return result;
}

module.exports = { bump, listFiles, collect, denyReason, scanForSecrets, makeZip, readZip, crc32, changelogEntry, today, run, MARK, ALLOW_DIRS, ALLOW_ROOT_FILES, REQUIRED };

if (require.main === module) {
  try {
    const r = run(process.argv.slice(2));
    console.log(r.dry ? `(simulación) ${r.old} → ${r.next}: ${r.zipPath}\narchivos: ${r.files} · excluidos: ${r.excluded} · origen: ${r.mode}` : `versión ${r.old} → ${r.next}\nZIP: ${r.zipPath}\narchivos: ${r.files} · bytes: ${r.bytes} · firma: ${r.signature} · origen de la lista: ${r.mode} · excluidos: ${r.excluded}\nNo se hizo commit, push ni despliegue.`);
    if (r.skippedTop.length) console.warn('AVISO: no entraron al paquete (fuera de las raíces permitidas): ' + r.skippedTop.join(', ') + '. Si deben distribuirse, añadirlos a ALLOW_DIRS / ALLOW_ROOT_FILES en tools/release.js.');
  } catch (e) { console.error(e.message); process.exit(1); }
}
