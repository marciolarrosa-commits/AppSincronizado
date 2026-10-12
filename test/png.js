'use strict';
// Decodificador mínimo de PNG (8 bits, RGB/RGBA, sin entrelazado) para comprobar PÍXELES REALMENTE RENDERIZADOS en capturas del navegador.
const zlib = require('zlib');

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('no es PNG');
  let pos = 8; let w; let h; let depth; let ctype; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8); const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; if (data[12] !== 0) throw new Error('PNG entrelazado no soportado'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || (ctype !== 2 && ctype !== 6)) throw new Error(`PNG no soportado (depth ${depth}, tipo ${ctype})`);
  const bpp = ctype === 6 ? 4 : 3; const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)); const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0; const b = prev ? prev[i] : 0; const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      row[i] = v & 255;
    }
  }
  return { width: w, height: h, bpp, pixel: (x, y) => [out[y * stride + x * bpp], out[y * stride + x * bpp + 1], out[y * stride + x * bpp + 2]] };
}

/** Comprueba que TODA la línea de borde (arriba, abajo, izquierda, derecha) y una malla interior tienen el color esperado (±tol). Devuelve las discrepancias. */
function checkCoverage(img, rgb, tol = 3, grid = 12) {
  const bad = []; const near = p => p.every((v, i) => Math.abs(v - rgb[i]) <= tol);
  const W = img.width; const H = img.height;
  for (let x = 0; x < W; x++) { if (!near(img.pixel(x, 0))) bad.push(['arriba', x, 0, img.pixel(x, 0)]); if (!near(img.pixel(x, H - 1))) bad.push(['abajo', x, H - 1, img.pixel(x, H - 1)]); }
  for (let y = 0; y < H; y++) { if (!near(img.pixel(0, y))) bad.push(['izquierda', 0, y, img.pixel(0, y)]); if (!near(img.pixel(W - 1, y))) bad.push(['derecha', W - 1, y, img.pixel(W - 1, y)]); }
  for (let gy = 1; gy < grid; gy++) for (let gx = 1; gx < grid; gx++) { const x = Math.floor(W * gx / grid); const y = Math.floor(H * gy / grid); if (!near(img.pixel(x, y))) bad.push(['malla', x, y, img.pixel(x, y)]); }
  return bad;
}

/** Fracción de píxeles (muestreo) que NO tienen el color esperado. */
function mismatchRatio(img, rgb, tol = 3, step = 4) {
  let bad = 0; let n = 0;
  for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) { n++; if (!img.pixel(x, y).every((v, i) => Math.abs(v - rgb[i]) <= tol)) bad++; }
  return bad / n;
}

module.exports = { decodePng, checkCoverage, mismatchRatio };
