'use strict';

/**
 * Digest: the local model reads files from disk and returns a short answer, so a
 * cloud model (Claude Code) gets the conclusion without paying for the input.
 *
 * Files are line-numbered so answers can cite path:line. Input that does not fit one
 * context window is split into chunks (map: notes per chunk, reduce: one answer).
 * Every answer is redacted by dual_ai/privacy.py before it leaves; if redaction
 * fails, no text is returned.
 */

const fs            = require('fs');
const path          = require('path');
const { spawn }     = require('child_process');

const CHUNK_CHARS   = parseInt(process.env.MOTKRA_CHUNK_CHARS ?? '24000', 10);
const MAX_CHARS     = parseInt(process.env.MOTKRA_MAX_CHARS ?? '600000', 10);
const MAX_FILES     = 50;
const CONTEXT_LINES = 2;

const DUAL_AI = path.resolve(__dirname, '..', 'dual_ai');
const VENV_PY = path.resolve(__dirname, '..', '.venv', 'Scripts', 'python.exe');
const PYTHON  = process.env.MOTKRA_PYTHON ?? (fs.existsSync(VENV_PY) ? VENV_PY : 'python');

const MAP_SYSTEM =
  'You read one part of the user\'s files and extract only what helps answer the question. ' +
  'Lines are prefixed with their number; cite every fact as path:line. Be terse. ' +
  'If this part has nothing relevant, reply exactly NONE.';

const ANSWER_SYSTEM = maxWords =>
  `Answer the question using only the files given. At most ${maxWords} words. ` +
  'Lines are prefixed with their number; cite facts as path:line. ' +
  'If the files do not contain the answer, say so. No preamble.';

const REDUCE_SYSTEM = maxWords =>
  `Combine the notes into one answer to the question. At most ${maxWords} words. ` +
  'Keep the path:line references. Use only facts present in the notes. No preamble.';

/** Resolve a path under root; refuse anything that escapes it. */
function resolveInside(root, p) {
  const realRoot = fs.realpathSync(root);
  const full = fs.realpathSync(path.resolve(realRoot, p));
  const rel = path.relative(realRoot, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${p} is outside the workspace (${realRoot})`);
  }
  return { full, rel: rel.split(path.sep).join('/') };
}

/** Number lines; with a pattern keep only matching lines plus a little context. */
function numberLines(text, pattern) {
  const lines = text.split(/\r?\n/);
  const width = String(lines.length).length;
  const fmt = i => `${String(i + 1).padStart(width)}| ${lines[i]}`;
  if (!pattern) return { text: lines.map((_, i) => fmt(i)).join('\n'), matches: lines.length };

  const keep = new Set();
  let matches = 0;
  lines.forEach((line, i) => {
    if (!pattern.test(line)) return;
    matches++;
    for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(lines.length - 1, i + CONTEXT_LINES); j++) keep.add(j);
  });
  const out = [];
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== prev + 1 && out.length) out.push('...');
    out.push(fmt(i));
    prev = i;
  }
  return { text: out.join('\n'), matches };
}

/** Read files into one line-numbered text block per file. */
function readInputs(paths, root, patternSource) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('"paths" must be a non-empty array');
  if (paths.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files per digest`);
  let pattern = null;
  if (patternSource) {
    try { pattern = new RegExp(patternSource, 'i'); } catch (e) { throw new Error(`Invalid pattern: ${e.message}`); }
  }

  const docs = [];
  let total = 0;
  for (const p of paths) {
    const { full, rel } = resolveInside(root, p);
    if (!fs.statSync(full).isFile()) throw new Error(`${p} is not a file`);
    const raw = fs.readFileSync(full, 'utf8');
    if (raw.includes('\u0000')) throw new Error(`${p} looks binary`);
    const { text, matches } = numberLines(raw, pattern);
    if (pattern && !matches) continue;
    total += text.length;
    if (total > MAX_CHARS) {
      throw new Error(`Input exceeds ${MAX_CHARS} characters; narrow it with "pattern" or fewer files`);
    }
    docs.push({ path: rel, text, rawChars: raw.length });
  }
  return docs;
}

/** Split documents into chunks of at most `size` characters, on line boundaries. */
function chunk(docs, size = CHUNK_CHARS) {
  const chunks = [];
  let cur = '';
  const push = () => { if (cur) chunks.push(cur); cur = ''; };
  for (const doc of docs) {
    let header = `=== ${doc.path} ===\n`;
    for (const line of doc.text.split('\n')) {
      if (cur && cur.length + header.length + line.length + 1 > size) {
        push();
        header = `=== ${doc.path} (continued) ===\n`;
      }
      cur += header + line + '\n';
      header = '';
    }
  }
  push();
  return chunks;
}

/** Redact secrets with dual_ai/privacy.py. Rejects (fail closed) if Python is unavailable. */
function pythonRedact(text) {
  return new Promise((resolve, reject) => {
    const code =
      'import json, sys\n' +
      'from privacy import redact\n' +
      'sys.stdout.write(json.dumps(redact(sys.stdin.read())[0]))\n';
    const child = spawn(PYTHON, ['-c', code], {
      cwd: DUAL_AI,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', e => reject(new Error(`Redaction unavailable: ${e.message}`)));
    child.on('close', status => {
      if (status !== 0) return reject(new Error(`Redaction failed: ${err.trim().split('\n').pop()}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Redaction returned invalid output')); }
    });
    child.stdin.end(text, 'utf8');
  });
}

/**
 * Answer `question` from the files at `paths`.
 * deps: { chat(system, prompt, maxTokens) -> Promise<string>, redact(text) -> Promise<string>, root, onProgress? }
 */
async function digest({ paths, question, pattern, maxWords = 150 }, deps) {
  if (!question) throw new Error('"question" is required');
  const started = Date.now();
  const docs = readInputs(paths, deps.root, pattern);
  const rawChars = docs.reduce((n, d) => n + d.rawChars, 0);
  if (!docs.length) {
    return { text: `No lines match pattern ${JSON.stringify(pattern)}.`, chunks: 0, rawChars, seconds: 0 };
  }

  const chunks = chunk(docs);
  const progress = deps.onProgress ?? (() => {});
  let answer;
  if (chunks.length === 1) {
    progress(`reading 1 chunk`);
    answer = await deps.chat(ANSWER_SYSTEM(maxWords), `${chunks[0]}\nQUESTION: ${question}`, maxWords * 3);
  } else {
    const notes = [];
    for (let i = 0; i < chunks.length; i++) {
      progress(`reading chunk ${i + 1}/${chunks.length}`);
      const note = (await deps.chat(MAP_SYSTEM, `${chunks[i]}\nQUESTION: ${question}`, 400)).trim();
      if (note && !/^NONE\.?$/i.test(note)) notes.push(note);
    }
    if (!notes.length) {
      answer = 'The files do not contain anything relevant to the question.';
    } else {
      progress('combining notes');
      answer = await deps.chat(
        REDUCE_SYSTEM(maxWords),
        `NOTES:\n${notes.map((n, i) => `--- part ${i + 1} ---\n${n}`).join('\n')}\n\nQUESTION: ${question}`,
        maxWords * 3,
      );
    }
  }

  const text = await deps.redact(answer.trim());
  return { text, chunks: chunks.length, rawChars, seconds: Math.round((Date.now() - started) / 1000) };
}

module.exports = { digest, readInputs, chunk, numberLines, resolveInside, pythonRedact, CHUNK_CHARS };
