'use strict';

// The Python "brain" (dual_ai/daemon.py --headless) owns routing and privacy: router v3,
// secret redaction and keeping personal conversations local. This app keeps the UI, the
// file tools and the model streaming, and asks the brain what to send where.

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');

const PORT    = parseInt(process.env.MOTKRA_BRAIN_PORT ?? '7433', 10);
const SCRIPT  = path.join(__dirname, '..', 'dual_ai', 'daemon.py');
const VENV_PY = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');   // monorepo dev venv
const PYTHON  = process.env.MOTKRA_PYTHON ?? (fs.existsSync(VENV_PY) ? VENV_PY : 'python');
const TIMEOUT = 5000;

let _proc = null;

function post(route, body, timeout = TIMEOUT) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: route, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          if (res.statusCode !== 200) return reject(new Error(json.error ?? `brain HTTP ${res.statusCode}`));
          resolve(json);
        } catch (err) { reject(err); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('brain timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

function isUp() {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port: PORT, path: '/status' }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf).status === 'ok'); } catch { resolve(false); } });
    });
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** Start the brain unless one is already running. Only works from the monorepo (dev). */
async function start() {
  if (await isUp()) return true;
  if (!fs.existsSync(SCRIPT)) {
    console.warn('[brain] dual_ai/daemon.py not found — using the basic keyword router');
    return false;
  }
  _proc = spawn(PYTHON, [SCRIPT, '--headless'], {
    cwd: path.dirname(SCRIPT),
    env: { ...process.env, DAEMON_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  _proc.stderr.on('data', d => console.warn('[brain]', d.toString().trim()));
  _proc.on('exit', code => { console.log(`[brain] exited (${code})`); _proc = null; });
  for (let i = 0; i < 40; i++) {           // imports take a few seconds on first run
    await new Promise(r => setTimeout(r, 250));
    if (await isUp()) { console.log(`[brain] ready on ${PORT}`); return true; }
  }
  console.warn('[brain] did not start — using the basic keyword router');
  return false;
}

function stop() {
  if (_proc) { try { _proc.kill(); } catch {} _proc = null; }
}

const MODE = { auto: 'auto', claude: 'cloud', gemma: 'local' };

/**
 * Routing decision for a conversation ending with the new user message.
 * Resolves to null when the brain is unreachable (caller falls back to the keyword router).
 */
async function plan(messages, model = 'auto') {
  try {
    return await post('/route', { messages, mode: MODE[model] ?? 'auto' });
  } catch (err) {
    console.warn('[brain] route failed:', err.message);
    return null;
  }
}

/** Redact more text (tool output) with the conversation's mapping. Throws if the brain is down. */
async function redact(text, secrets) {
  return post('/redact', { text, secrets });
}

function restore(text, secrets) {
  for (const [placeholder, value] of Object.entries(secrets ?? {})) text = text.split(placeholder).join(value);
  return text;
}

/** Restore placeholders in every string of a tool input, so tools act on the real values. */
function restoreDeep(value, secrets) {
  if (typeof value === 'string') return restore(value, secrets);
  if (Array.isArray(value)) return value.map(v => restoreDeep(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreDeep(v, secrets)]));
  }
  return value;
}

/** Same as privacy.StreamRestorer in Python: chunks may split a placeholder. */
class StreamRestorer {
  constructor(secrets) { this.secrets = secrets ?? {}; this.pending = ''; }

  feed(chunk) {
    this.pending += chunk;
    const cut = this.pending.lastIndexOf('[');
    let out;
    if (cut === -1 || this.pending.slice(cut).includes(']') || this.pending.length - cut > 40) {
      out = this.pending; this.pending = '';
    } else {
      out = this.pending.slice(0, cut); this.pending = this.pending.slice(cut);
    }
    return restore(out, this.secrets);
  }

  flush() {
    const out = this.pending; this.pending = '';
    return restore(out, this.secrets);
  }
}

module.exports = { PORT, PYTHON, start, stop, isUp, plan, redact, restore, restoreDeep, StreamRestorer };
