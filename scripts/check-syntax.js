'use strict';
// Verificación de sintaxis de todo el JavaScript del proyecto (servidor, cliente, pruebas y herramientas) sin ejecutarlo.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const dirs = ['src', 'public/js', 'test', 'e2e', 'tools', 'scripts'];
const files = ['server.js'];
(function walk(d) { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const rel = path.join(d, e.name); if (e.isDirectory()) walk(rel); else if (e.name.endsWith('.js')) files.push(rel); } });
for (const d of dirs) (function walk(dir) { for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) { const rel = path.join(dir, e.name); if (e.isDirectory()) walk(rel); else if (e.name.endsWith('.js')) files.push(rel); } })(d);
let bad = 0;
for (const f of files) { const r = spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' }); if (r.status !== 0) { bad++; console.error('SINTAXIS ✖', f, '\n' + r.stderr.split('\n').slice(0, 4).join('\n')); } }
console.log(bad ? `${bad} archivo(s) con errores` : `sintaxis OK: ${files.length} archivos`);
process.exit(bad ? 1 : 0);
