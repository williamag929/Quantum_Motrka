#!/usr/bin/env node
// Generates icons/icon16.png, icon48.png, icon128.png
// using only Node.js built-ins (zlib + CRC32).
// Run: node scripts/generate-icons.js  — or via npm postinstall.

'use strict';

const fs   = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'icons');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── CRC32 ──────────────────────────────────────────────────────────────────

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── PNG chunk builder ──────────────────────────────────────────────────────

function chunk(type, data) {
  const t   = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length);
  const crc = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

// ── PNG generation ─────────────────────────────────────────────────────────

function makePng(size) {
  // Build RGB pixel data: teal circle on dark background
  const rows = [];
  const r    = size * 0.38;   // circle radius as fraction of size
  const cx   = (size - 1) / 2;
  const cy   = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const dx   = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const i    = 1 + x * 3;

      if (dist <= r * 0.7) {
        // Inner fill — bright teal
        row[i]   = 0;
        row[i+1] = 200;
        row[i+2] = 150;
      } else if (dist <= r) {
        // Ring — darker teal border
        row[i]   = 0;
        row[i+1] = 140;
        row[i+2] = 105;
      } else {
        // Background — near-black
        row[i]   = 22;
        row[i+1] = 22;
        row[i+2] = 22;
      }
    }
    rows.push(row);
  }

  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB, no interlace

  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), // PNG sig
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Write ──────────────────────────────────────────────────────────────────

for (const size of [16, 48, 128]) {
  const outPath = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, makePng(size));
  console.log(`Generated ${outPath} (${size}×${size})`);
}

console.log('Icons ready.');
