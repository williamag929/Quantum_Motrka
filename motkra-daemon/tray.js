'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');
const zlib = require('zlib');

let _tray = null;

// ── Programmatic 16×16 teal-circle PNG (no external assets needed) ────────

function buildPng() {
  const w = 16, h = 16;

  // ── CRC32 table ──
  const T = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    T[n] = c;
  }
  function crc32(buf) {
    let crc = 0xffffffff;
    for (const b of buf) crc = T[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const t   = Buffer.from(type);
    const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length);
    const crc = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  }

  // ── IHDR: 16×16, 8-bit, RGB ──
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  // ── Pixel rows ──
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    row[0] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      const dx = x - 7.5, dy = y - 7.5;
      const ring  = (dx*dx + dy*dy);
      const inner = ring <= 25;   // r=5: teal fill
      const outer = ring <= 49;   // r=7: dark border
      const i = 1 + x * 3;
      row[i]   = inner ? 0   : outer ? 20  : 30;  // R
      row[i+1] = inner ? 188 : outer ? 140 : 30;  // G
      row[i+2] = inner ? 136 : outer ? 100 : 30;  // B
    }
    rows.push(row);
  }

  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function createIcon() {
  // Prefer a real icon file if present
  const candidates = [
    path.join(__dirname, 'assets', 'tray-icon.png'),
    path.join(__dirname, 'assets', 'icon.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  }
  // Fallback: build a minimal teal-circle PNG in memory
  try {
    const png = buildPng();
    return nativeImage.createFromBuffer(png);
  } catch {
    return nativeImage.createEmpty();
  }
}

// ── Public API ────────────────────────────────────────────────────────────

let _emailEnabled  = false;
let _emailToggleFn = null;

/**
 * @param {Object} callbacks
 * @param {Function} callbacks.onOpenChat
 * @param {Function} callbacks.onOpenVSCode
 * @param {Function} callbacks.onQuit
 * @param {Function} callbacks.onEmailToggle
 */
function createTray({ onOpenChat, onOpenVSCode, onQuit, onEmailToggle }) {
  const icon = createIcon();
  _emailToggleFn = onEmailToggle;

  _tray = new Tray(icon);
  _tray.setToolTip('Motkra — AI Coding Agent');

  rebuildMenu({ onOpenChat, onOpenVSCode, onQuit });

  // Single-click on Windows opens chat; on macOS left-click shows menu
  if (process.platform === 'win32') _tray.on('click', onOpenChat);

  return _tray;
}

function rebuildMenu({ onOpenChat, onOpenVSCode, onQuit }) {
  const emailLabel = _emailEnabled ? '📧 Email Agent  ●  (running)' : '📧 Email Agent  ○  (stopped)';
  const menu = Menu.buildFromTemplate([
    { label: '🤖 Motkra Chat',                    click: onOpenChat  },
    { label: '⌨  Quick Query  Ctrl+Shift+Space',  enabled: false     },
    { type: 'separator' },
    {
      label:   emailLabel,
      submenu: [
        {
          label: _emailEnabled ? 'Stop Email Agent' : 'Start Email Agent',
          click: () => {
            _emailEnabled = !_emailEnabled;
            _emailToggleFn?.();
            rebuildMenu({ onOpenChat, onOpenVSCode, onQuit });
          },
        },
        { type: 'separator' },
        { label: 'Email agent monitors your Gmail inbox,', enabled: false },
        { label: 'triages messages with Claude, and replies', enabled: false },
        { label: 'based on your contact trust levels.',      enabled: false },
      ],
    },
    { type: 'separator' },
    { label: '📂 Open VS Code',                   click: onOpenVSCode },
    { type: 'separator' },
    { label: '✕  Quit Motkra',                    click: onQuit      },
  ]);
  _tray.setContextMenu(menu);
}

module.exports = { createTray };
