'use strict';

// Safe command execution for the run_command tool: one program and its arguments, no shell.
// Checking only the first word and then handing the whole line to a shell let
// "git status & del /s /q *" pass an allowlist of ["git"]. Same rules as
// motkra-daemon/console-tools.js (kept separate because this extension ships on its own).

const fs   = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const IS_WIN      = process.platform === 'win32';
const CHAIN_CHARS = /[&|;<>`\r\n]/;
const CMD_UNSAFE  = /["%^&|<>!\r\n]/;
const SECRET_ENV  = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const MAX_OUTPUT  = 20_000;

/** Split a command line into argv; chaining, pipes and redirection are refused. */
function tokenize(command) {
  const argv = [];
  let cur = '', quote = null, started = false;
  for (const ch of String(command)) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch) && !CHAIN_CHARS.test(ch)) {
      if (started) { argv.push(cur); cur = ''; started = false; }
      continue;
    }
    if (CHAIN_CHARS.test(ch)) {
      throw new Error(`"${ch}" is not supported: run one program at a time, without pipes, chaining or redirection.`);
    }
    cur += ch; started = true;
  }
  if (quote) throw new Error('Unclosed quote in command.');
  if (started) argv.push(cur);
  if (!argv.length) throw new Error('Empty command.');
  return argv;
}

function programName(argv0) {
  return path.basename(argv0).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

function resolveProgram(name, env = process.env) {
  if (name.includes('/') || name.includes('\\')) return fs.existsSync(name) ? path.resolve(name) : null;
  const exts = IS_WIN ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toLowerCase()) : [''];
  const hasExt = IS_WIN && exts.includes(path.extname(name).toLowerCase());
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of hasExt ? [''] : exts) {
      const full = path.join(dir, name + ext);
      try { if (fs.statSync(full).isFile()) return full; } catch {}
    }
  }
  return null;
}

/** The extension host holds API keys in its environment; commands must not see them. */
function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k)));
}

function spawnArgs(file, args) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    const bad = [file, ...args].find(a => CMD_UNSAFE.test(a));
    if (bad) throw new Error(`Argument not allowed for a batch program: ${bad}`);
    const line = [file, ...args].map(a => (a === '' || /\s/.test(a) ? `"${a}"` : a)).join(' ');
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { file, args, verbatim: false };
}

/**
 * Run `command` if its program is in `allowed`.
 * @returns {Promise<string>} output text for the model
 */
function runAllowed(command, { cwd, allowed, timeoutMs }) {
  let argv;
  try { argv = tokenize(command); } catch (err) { return Promise.resolve(`Error: ${err.message}`); }
  const prog = programName(argv[0]);
  if (!allowed.map(a => a.toLowerCase()).includes(prog)) {
    return Promise.resolve(`Error: '${argv[0]}' is not in motkra.allowedCommands.\nAllowed: ${allowed.join(', ')}`);
  }
  const file = resolveProgram(argv[0]);
  if (!file) return Promise.resolve(`Error: program not found on PATH: ${argv[0]}`);
  let spec;
  try { spec = spawnArgs(file, argv.slice(1)); } catch (err) { return Promise.resolve(`Error: ${err.message}`); }

  return new Promise(resolve => {
    let out = '', timedOut = false;
    const child = spawn(spec.file, spec.args, {
      cwd, env: childEnv(), shell: false, windowsHide: true, windowsVerbatimArguments: spec.verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const add = d => { if (out.length < MAX_OUTPUT) out += d.toString(); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {}); else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', err => { clearTimeout(timer); resolve(`Error: ${err.message}`); });
    child.on('close', code => {
      clearTimeout(timer);
      const text = out.trim().slice(0, MAX_OUTPUT);
      if (timedOut) resolve(`${text}\n(stopped after ${timeoutMs / 1000}s)`.trim());
      else if (text) resolve(text);
      else resolve(code ? `Exit code ${code}` : 'Done (no output)');
    });
  });
}

module.exports = { tokenize, programName, resolveProgram, childEnv, spawnArgs, runAllowed };
