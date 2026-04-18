// tools/make-icons.js
// Generates src/icons/icon-{16,48,128}.png with a Phia-orange background
// and a white rounded-square shopping-bag motif. No npm deps.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const ORANGE = [0xFF, 0x7A, 0x1A];
const WHITE = [0xFF, 0xFF, 0xFF];

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

// Draw a size×size icon: orange bg, white rounded-square shopping-bag mark.
// Returns a Buffer containing the PNG.
function makeIcon(size) {
  const pad = Math.max(2, Math.floor(size * 0.18));   // bag inset from edges
  const bagTop = pad + Math.floor(size * 0.08);       // bag top edge (below handle)
  const handleTop = pad;                              // handle top edge
  const handleSide = Math.floor(size * 0.32);         // handle horizontal size
  const strokeW = Math.max(1, Math.floor(size * 0.09)); // handle/bag stroke thickness
  const radius = Math.max(1, Math.floor(size * 0.12)); // rounded corner radius for bag body

  function inRoundedRect(x, y, x0, y0, x1, y1, r) {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    // corners
    if (x < x0 + r && y < y0 + r) return (x - (x0+r))**2 + (y - (y0+r))**2 <= r*r;
    if (x > x1 - r && y < y0 + r) return (x - (x1-r))**2 + (y - (y0+r))**2 <= r*r;
    if (x < x0 + r && y > y1 - r) return (x - (x0+r))**2 + (y - (y1-r))**2 <= r*r;
    if (x > x1 - r && y > y1 - r) return (x - (x1-r))**2 + (y - (y1-r))**2 <= r*r;
    return true;
  }

  function isWhite(x, y) {
    // bag body: rounded rect from (pad, bagTop) to (size-pad, size-pad)
    if (inRoundedRect(x, y, pad, bagTop, size - pad, size - pad, radius)) return true;
    // handle: a thin horizontal arc approximated as the outline of a smaller rounded rect
    // Draw an arch: outer rect minus inner rect, stopping at bagTop
    const hx0 = Math.floor(size/2) - Math.floor(handleSide/2);
    const hx1 = hx0 + handleSide;
    const hy0 = handleTop;
    const hy1 = bagTop;
    const outer = (x >= hx0 && x <= hx1 && y >= hy0 && y <= hy1);
    const innerPad = strokeW;
    const inner = (x >= hx0 + innerPad && x <= hx1 - innerPad && y >= hy0 + innerPad && y <= hy1);
    if (outer && !inner) return true;
    return false;
  }

  // Build raw pixel rows: filter byte 0 + RGB triples
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const c = isWhite(x, y) ? WHITE : ORANGE;
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
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

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
