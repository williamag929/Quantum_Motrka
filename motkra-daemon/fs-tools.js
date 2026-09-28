'use strict';

// Filesystem tools for the Motkra agent, gated by per-folder user consent.
// A grant covers a folder and everything below it, for one operation (read or write).

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const MOTKRA_DIR   = process.env.MOTKRA_DIR ?? path.join(os.homedir(), '.motkra');
const GRANTS_FILE  = path.join(MOTKRA_DIR, 'permissions.json');
const AUDIT_FILE   = path.join(MOTKRA_DIR, 'fs-audit.jsonl');

const MAX_READ_BYTES   = 100_000;
const MAX_LIST_ENTRIES = 400;
const MAX_WRITE_BYTES  = 500_000;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.pytest_cache']);

const SCOPES = ['once', 'session', 'always', 'deny'];

// File contents are sent to the cloud model, so some paths stay off-limits even inside a granted folder.
const BLOCKED_DIRS = ['.ssh', '.motkra', '.aws', '.gnupg', '.azure', '.kube'].map(d => path.join(os.homedir(), d));
function isBlocked(p) {
  const base = path.basename(p).toLowerCase();
  if (/^\.env(\..+)?$/.test(base) && base !== '.env.example') return true;
  if (/\.(pem|key|pfx|p12|keystore)$/.test(base) || /^id_(rsa|ed25519|ecdsa|dsa)/.test(base)) return true;
  return BLOCKED_DIRS.some(d => isInside(p, d));
}

// ── Path helpers ───────────────────────────────────────────────────────────

function norm(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function isInside(child, parent) {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve symlinks for existing paths so a link cannot escape a granted folder. */
function realTarget(p) {
  if (!path.isAbsolute(p)) throw new Error(`Path must be absolute: ${p}`);
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

// ── Grants ─────────────────────────────────────────────────────────────────

const sessionGrants = [];        // { op, folder }
let   alwaysGrants  = loadGrants();

function loadGrants() {
  try { return JSON.parse(fs.readFileSync(GRANTS_FILE, 'utf8')).filter(g => g.op && g.folder); }
  catch { return []; }
}

function saveGrants() {
  fs.mkdirSync(MOTKRA_DIR, { recursive: true });
  fs.writeFileSync(GRANTS_FILE, JSON.stringify(alwaysGrants, null, 2));
}

function isGranted(target, op) {
  return [...sessionGrants, ...alwaysGrants].some(g => g.op === op && isInside(target, g.folder));
}

function addGrant(folder, op, scope) {
  const grant = { op, folder: path.resolve(folder), granted_at: new Date().toISOString() };
  if (scope === 'session') sessionGrants.push(grant);
  if (scope === 'always') { alwaysGrants.push(grant); saveGrants(); }
}

function listGrants() {
  return [
    ...alwaysGrants.map(g => ({ ...g, scope: 'always' })),
    ...sessionGrants.map(g => ({ ...g, scope: 'session' })),
  ];
}

function revokeAll() {
  sessionGrants.length = 0;
  alwaysGrants = [];
  saveGrants();
}

function audit(entry) {
  try {
    fs.mkdirSync(MOTKRA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* auditing must never break the agent */ }
}

/**
 * Ensure the user allowed `op` on `folder` (and so on `target` inside it).
 * `ask({op, folder, target})` resolves to one of SCOPES.
 */
async function authorize(target, folder, op, ask) {
  if (isBlocked(target)) {
    audit({ op, target, result: 'blocked' });
    throw new Error(`Motkra never shares ${target}: it may hold credentials or private keys.`);
  }
  if (isGranted(target, op)) { audit({ op, target, result: 'granted' }); return; }

  const scope = await ask({ op, folder, target });
  if (!SCOPES.includes(scope) || scope === 'deny') {
    audit({ op, target, folder, result: 'denied' });
    throw new Error(`The user denied ${op} access to ${folder}. Do not retry; ask the user what to do instead.`);
  }
  addGrant(folder, op, scope);
  audit({ op, target, folder, result: `allowed (${scope})` });
}

// ── Tools ──────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_directory',
    description:
      'List the files and folders inside a directory on the user\'s computer. Use absolute paths. ' +
      'Set depth (1-3) to include subfolders. The user is asked for permission the first time a folder is used.',
    input_schema: {
      type: 'object',
      properties: {
        path:  { type: 'string', description: 'Absolute directory path, e.g. D:\\Projects\\MyApp' },
        depth: { type: 'integer', description: 'How many levels to list (1-3). Default 2.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a text file on the user\'s computer (absolute path). Large files are truncated. ' +
      'The user is asked for permission the first time its folder is used.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute file path' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a text file on the user\'s computer (absolute path). Only use it when the user asked ' +
      'you to change or create files. The user must separately allow writing to the folder.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Absolute file path' },
        content: { type: 'string', description: 'Full new file content' },
      },
      required: ['path', 'content'],
    },
  },
];

function listTree(dir, depth, prefix = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { out.push(`${prefix}(unreadable: ${e.code})`); return out; }
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= MAX_LIST_ENTRIES) { out.push(`${prefix}… (truncated at ${MAX_LIST_ENTRIES} entries)`); break; }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const skipped = SKIP_DIRS.has(e.name);
      out.push(`${prefix}${e.name}/${skipped ? '  (contents skipped)' : ''}`);
      if (!skipped && depth > 1) listTree(full, depth - 1, prefix + '  ', out);
    } else {
      let size = '';
      try { size = ` (${fs.statSync(full).size} B)`; } catch {}
      out.push(`${prefix}${e.name}${size}`);
    }
  }
  return out;
}

/**
 * Run one tool call. `ask` shows the permission prompt; `onActivity` reports progress to the UI.
 * @returns {Promise<string>} tool result text
 */
async function runTool(name, input, { ask, onActivity } = {}) {
  const target = realTarget(String(input?.path ?? ''));

  if (name === 'list_directory') {
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`Not a directory: ${target}`);
    await authorize(target, target, 'read', ask);
    onActivity?.(`📂 Listing ${target}`);
    const depth = Math.min(Math.max(parseInt(input.depth ?? 2, 10) || 2, 1), 3);
    return [`${target}/`, ...listTree(target, depth, '  ')].join('\n');
  }

  if (name === 'read_file') {
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`Not a file: ${target}`);
    await authorize(target, path.dirname(target), 'read', ask);
    onActivity?.(`📄 Reading ${target}`);
    const buf = fs.readFileSync(target);
    if (buf.subarray(0, 8000).includes(0)) return `${target} looks like a binary file (${buf.length} bytes); not shown.`;
    const text = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
    return buf.length > MAX_READ_BYTES ? `${text}\n\n… (truncated: showing ${MAX_READ_BYTES} of ${buf.length} bytes)` : text;
  }

  if (name === 'write_file') {
    const content = String(input?.content ?? '');
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error('Content too large to write.');
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) throw new Error(`Is a directory: ${target}`);
    await authorize(target, path.dirname(target), 'write', ask);
    onActivity?.(`✏️ Writing ${target}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return `Wrote ${Buffer.byteLength(content)} bytes to ${target}.`;
  }

  throw new Error(`Unknown tool: ${name}`);
}

module.exports = { TOOLS, SCOPES, runTool, listGrants, revokeAll, isBlocked, isInside };
