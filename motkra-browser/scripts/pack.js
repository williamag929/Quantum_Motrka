#!/usr/bin/env node
// Creates dist/motkra-browser.zip ready for Chrome Web Store upload.
// Run: npm run build

'use strict';

const fs      = require('fs');
const path    = require('path');
const archiver = require('archiver');

const ROOT    = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT     = path.join(OUT_DIR, 'motkra-browser.zip');

fs.mkdirSync(OUT_DIR, { recursive: true });

const output = fs.createWriteStream(OUT);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`\nPacked: ${OUT} (${(archive.pointer() / 1024).toFixed(1)} KB)`);
  console.log('Upload to: https://chrome.google.com/webstore/devconsole');
});

archive.on('error', err => { throw err; });
archive.pipe(output);

// Files to include in the extension zip
const INCLUDE = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

for (const f of INCLUDE) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) {
    archive.file(src, { name: f });
  } else {
    console.warn(`Warning: missing ${f}`);
  }
}

archive.finalize();
