'use strict';

// Local voice. dual_ai/voice_worker.py runs Whisper (speech-to-text) and Piper (text-to-speech)
// in one long-lived Python process so the model stays loaded between turns; it talks JSON lines
// on stdin/stdout. When Python or the voice extras are missing, listening falls back to Windows
// System.Speech (voice/stt-win.ps1) and speak() returns false so the renderer uses the browser
// voice. Audio never leaves the machine either way.

const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');
const { PYTHON } = require('./brain');

const WORKER   = path.join(__dirname, '..', 'dual_ai', 'voice_worker.py');
const FALLBACK = path.join(__dirname, 'voice', 'stt-win.ps1');

let _worker   = null;
let _state    = 'off';   // 'off' | 'starting' | 'ready' | 'failed'
let _stopping = false;
let _onText   = null;    // receives transcripts while listening
let _winStt   = null;    // stt-win.ps1 process (fallback)

/** Calls cb(line) for each complete line of a stream, whatever the chunk boundaries. */
function lineSplitter(cb) {
  let buf = '';
  return chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) if (line.trim()) cb(line.trim());
  };
}

/** A worker stdout line as {event, ...}, or null for anything that is not one. */
function parseEvent(line) {
  try {
    const ev = JSON.parse(line);
    return ev && typeof ev.event === 'string' ? ev : null;
  } catch { return null; }
}

function handleEvent(ev) {
  if (ev.event === 'ready') {
    _state = 'ready';
    console.log(`[voice] Whisper ${ev.stt} (${ev.language}) ready`);
  } else if (ev.event === 'transcript') {
    _onText?.(ev.text);
  } else if (ev.event === 'error') {
    console.warn('[voice]', ev.message);
  }
}

function send(cmd) {
  if (_worker?.stdin.writable) _worker.stdin.write(JSON.stringify(cmd) + '\n');
}

/** Start the worker (loads Whisper in the background). Only works from the monorepo (dev). */
function start() {
  if (_worker || _state === 'failed') return;
  if (!fs.existsSync(WORKER)) {
    console.warn('[voice] dual_ai/voice_worker.py not found — using Windows speech recognition');
    _state = 'failed';
    return;
  }
  _state = 'starting';
  _stopping = false;
  _worker = spawn(PYTHON, [WORKER], {
    cwd: path.dirname(WORKER),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  _worker.stdout.setEncoding('utf8');   // a chunk may end in the middle of "¿" or "é"
  _worker.stdout.on('data', lineSplitter(line => { const ev = parseEvent(line); if (ev) handleEvent(ev); }));
  _worker.stderr.on('data', d => console.warn('[voice]', d.toString().trim()));
  _worker.stdin.on('error', () => {});   // the exit handler deals with a dead worker
  _worker.on('error', err => console.warn('[voice] could not start the worker:', err.message));
  _worker.on('close', code => {
    _worker = null;
    if (_stopping) { _state = 'off'; return; }
    console.warn(`[voice] worker exited (${code}) — using Windows speech recognition`);
    _state = 'failed';
    if (_onText) startWinStt();   // keep listening with the fallback
  });
}

function stop() {
  _stopping = true;
  stopListening();
  if (_worker) {
    const proc = _worker;
    send({ cmd: 'quit' });
    proc.stdin.end();
    setTimeout(() => { try { proc.kill(); } catch {} }, 1500).unref();
  }
}

/** Listen continuously; onText(text) fires once per utterance until stopListening(). */
function listen(onText) {
  _onText = onText;
  if (_worker) send({ cmd: 'listen' });
  else startWinStt();
}

function stopListening() {
  _onText = null;
  send({ cmd: 'stop' });
  stopWinStt();
}

/** Speak a reply with Piper. Returns false when the worker is not ready (use another voice). */
function speak(text) {
  if (_state !== 'ready' || !text) return false;
  send({ cmd: 'speak', text });
  return true;
}

function hush() {
  send({ cmd: 'hush' });
}

// ── Fallback: Windows System.Speech via PowerShell ────────────────────────

function startWinStt() {
  if (_winStt) return;
  _winStt = spawn('powershell.exe', [
    '-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FALLBACK,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  _winStt.stdout.on('data', lineSplitter(text => _onText?.(text)));
  _winStt.stderr.on('data', d => console.warn('[stt]', d.toString().trim()));
  _winStt.on('exit', code => { console.log(`[stt] process exited (${code})`); _winStt = null; });
}

function stopWinStt() {
  if (_winStt) { try { _winStt.kill(); } catch {} _winStt = null; }
}

module.exports = { start, stop, listen, stopListening, speak, hush, lineSplitter, parseEvent };
