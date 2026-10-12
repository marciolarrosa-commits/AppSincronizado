'use strict';
// Genera los íconos PNG de la aplicación instalable (sin dependencias: PNG escrito a mano con zlib). Uso: node tools/make-icons.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }

function png(size, { maskable }) {
  const bg = [12, 13, 16]; const gold = [246, 210, 10]; const ring = [246, 210, 10];
  const cx = size / 2; const cy = size / 2;
  const rCore = size * (maskable ? 0.17 : 0.24);          // el ícono "maskable" deja un margen de seguridad (el sistema recorta hasta el 20 %)
  const rRing1 = rCore * 1.55; const rRing2 = rCore * 1.55 + size * 0.018;
  const stride = size * 4; const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); let c = bg;
      if (d <= rCore) c = gold; else if (d >= rRing1 && d <= rRing2) c = ring;
      const o = y * (stride + 1) + 1 + x * 4; raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const [name, size, maskable] of [['apple-touch-icon.png', 180, false], ['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-512-maskable.png', 512, true]]) {
  fs.writeFileSync(path.join(out, name), png(size, { maskable })); console.log('generado', name, size);
}
