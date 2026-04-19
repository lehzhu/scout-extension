// tools/make-icons.js
// Generates src/icons/icon-{16,48,128}.png with an orange background
// and a white scout/campaign-hat silhouette. No npm deps.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const BLUE  = [0x1E, 0x66, 0xD0];
const CREAM = [0xFF, 0xF5, 0xE8];
const BAND  = [0x6B, 0x44, 0x23];

function crc32Table() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = crc32Table();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makeIcon(size) {
  const cx = size / 2;

  // Crown (trapezoid narrowing toward top)
  const crownTopY      = size * 0.22;
  const crownBaseY     = size * 0.63;
  const crownTopHalfW  = size * 0.12;
  const crownBaseHalfW = size * 0.21;

  // Rounded cap on the crown top
  const capCy  = crownTopY;
  const capRx  = crownTopHalfW;
  const capRy  = size * 0.08;

  // Hatband — thin darker stripe just above where crown meets brim
  const bandTop   = size * 0.56;
  const bandBot   = size * 0.63;

  // Wide brim (horizontal ellipse)
  const brimCy = size * 0.72;
  const brimRx = size * 0.44;
  const brimRy = size * 0.085;

  function inCrown(x, y) {
    if (y < crownTopY || y > crownBaseY) return false;
    const t = (y - crownTopY) / (crownBaseY - crownTopY);
    const halfW = crownTopHalfW + t * (crownBaseHalfW - crownTopHalfW);
    return Math.abs(x - cx) <= halfW;
  }

  function inCrownCap(x, y) {
    if (y > capCy) return false;
    const dx = (x - cx) / capRx;
    const dy = (y - capCy) / capRy;
    return dx * dx + dy * dy <= 1;
  }

  function inBrim(x, y) {
    const dx = (x - cx) / brimRx;
    const dy = (y - brimCy) / brimRy;
    return dx * dx + dy * dy <= 1;
  }

  function inBand(x, y) {
    // Band sits inside the crown footprint at its bottom
    if (!inCrown(x, y)) return false;
    return y >= bandTop && y <= bandBot;
  }

  function colorAt(x, y) {
    if (inBand(x, y)) return BAND;
    if (inCrown(x, y) || inCrownCap(x, y) || inBrim(x, y)) return CREAM;
    return BLUE;
  }

  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const c = colorAt(x + 0.5, y + 0.5);
      const off = y * rowLen + 1 + x * 3;
      raw[off] = c[0]; raw[off + 1] = c[1]; raw[off + 2] = c[2];
    }
  }
  const idat = zlib.deflateSync(raw);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 48, 128];
const outDir = path.join(__dirname, '..', 'src', 'icons');
for (const s of sizes) {
  const file = path.join(outDir, `icon-${s}.png`);
  fs.writeFileSync(file, makeIcon(s));
  console.log(`wrote ${file} (${s}x${s})`);
}
