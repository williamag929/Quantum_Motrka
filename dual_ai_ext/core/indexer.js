'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────

const TEXT_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.env.example',
  '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  '.sh', '.bash', '.zsh', '.ps1', '.sql',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.nyc_output', 'vendor', '.cache', 'tmp', 'temp',
]);

const MAX_FILE_BYTES = 500 * 1024; // 500 KB
const MAX_FILES      = 2_000;
const MAX_DEPTH      = 8;

// ── In-memory index ──────────────────────────────────────────────────────────
// Map<absPath, { tf: Map<term,count>, total: number, head: string, mtime: number }>
const _docs = new Map();
const _df   = new Map(); // term → document-frequency count
let   _ready = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && t.length <= 40);
}

function* walkFiles(dir, depth = 0) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walkFiles(full, depth + 1);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (TEXT_EXTS.has(ext)) yield full;
    }
  }
}

function _addToDF(tf) {
  for (const term of tf.keys()) _df.set(term, (_df.get(term) ?? 0) + 1);
}

function _removeFromDF(tf) {
  for (const term of tf.keys()) {
    const n = (_df.get(term) ?? 1) - 1;
    if (n <= 0) _df.delete(term); else _df.set(term, n);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Index (or re-index) a single file incrementally.
 * Safe to call on every save — skips if mtime unchanged.
 */
function indexFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) return;

    const cached = _docs.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) return; // unchanged

    const content = fs.readFileSync(filePath, 'utf8');
    const tokens  = tokenize(content);
    const tf      = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    if (cached) _removeFromDF(cached.tf);
    _addToDF(tf);

    _docs.set(filePath, {
      tf,
      total: tokens.length,
      head:  content.slice(0, 600),
      mtime: stat.mtimeMs,
    });
  } catch { /* unreadable — skip */ }
}

/** Remove a deleted file from the index. */
function removeFile(filePath) {
  const cached = _docs.get(filePath);
  if (!cached) return;
  _removeFromDF(cached.tf);
  _docs.delete(filePath);
}

/**
 * Build the full index for a workspace root. Synchronous but capped at
 * MAX_FILES. Runs in ~200-800 ms for a typical project; large monorepos
 * hit the file cap quickly.
 * @param {string} workspaceRoot
 * @returns {number} files indexed
 */
function index(workspaceRoot) {
  _ready = false;
  _docs.clear();
  _df.clear();

  let count = 0;
  for (const fp of walkFiles(workspaceRoot)) {
    indexFile(fp);
    if (++count >= MAX_FILES) break;
  }

  _ready = true;
  return _docs.size;
}

/**
 * TF-IDF query — returns the top-K most relevant files with an excerpt.
 * @param {string} queryText
 * @param {number} topK
 * @returns {{ filePath: string, score: number, excerpt: string }[]}
 */
function query(queryText, topK = 3) {
  if (!_ready || _docs.size === 0) return [];

  const qTerms = [...new Set(tokenize(queryText))];
  if (!qTerms.length) return [];

  const N      = _docs.size;
  const scored = [];

  for (const [filePath, doc] of _docs) {
    let score = 0;
    for (const term of qTerms) {
      const tf  = (doc.tf.get(term) ?? 0) / Math.max(doc.total, 1);
      const idf = Math.log((N + 1) / ((_df.get(term) ?? 0) + 1)) + 1;
      score += tf * idf;
    }
    if (score > 0) scored.push({ filePath, score, doc });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK).map(({ filePath, doc }) => {
    // Find the first line that contains any query term for the excerpt
    const lines = doc.head.split('\n');
    let excerpt = '';
    for (const line of lines) {
      if (qTerms.some(t => line.toLowerCase().includes(t))) {
        excerpt = line.trim().slice(0, 220);
        break;
      }
    }
    if (!excerpt) excerpt = doc.head.replace(/\s+/g, ' ').slice(0, 220);
    return { filePath, excerpt };
  });
}

function isReady()   { return _ready; }
function fileCount() { return _docs.size; }

module.exports = { index, indexFile, removeFile, query, isReady, fileCount };
