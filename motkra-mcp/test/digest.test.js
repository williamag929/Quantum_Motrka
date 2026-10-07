'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { digest, readInputs, chunk, numberLines, pythonRedact } = require('../digest');
const { JobQueue } = require('../jobs');
const { createHandler } = require('../index');

function workspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-mcp-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

const identity = async t => t;

test('numberLines numbers every line, or only matches with context', () => {
  assert.strictEqual(numberLines('a\nb', null).text, '1| a\n2| b');
  const lines = Array.from({ length: 20 }, (_, i) => (i === 9 ? 'ERROR boom' : `ok ${i + 1}`)).join('\n');
  const { text, matches } = numberLines(lines, /error/i);
  assert.strictEqual(matches, 1);
  assert.deepStrictEqual(text.split('\n'), [' 8| ok 8', ' 9| ok 9', '10| ERROR boom', '11| ok 11', '12| ok 12']);
});

test('readInputs refuses paths outside the workspace', () => {
  const root = workspace({ 'a.txt': 'hi' });
  assert.throws(() => readInputs(['../outside.txt'], root), /outside the workspace|ENOENT/);
  assert.throws(() => readInputs([path.join(os.homedir(), '.bashrc')], root), /outside the workspace|ENOENT/);
  assert.throws(() => readInputs([], root), /non-empty/);
  assert.throws(() => readInputs(['a.txt'], root, '('), /Invalid pattern/);
  assert.strictEqual(readInputs(['a.txt'], root)[0].path, 'a.txt');
});

test('chunk splits on line boundaries and labels continued files', () => {
  const docs = [{ path: 'big.log', text: Array.from({ length: 100 }, (_, i) => `${i + 1}| line`).join('\n') }];
  const chunks = chunk(docs, 300);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(c => c.length <= 300 + 40));
  assert.match(chunks[0], /^=== big\.log ===/);
  assert.match(chunks[1], /^=== big\.log \(continued\) ===/);
  assert.strictEqual(chunks.join('').match(/\| line/g).length, 100);
});

test('digest answers a small input in one call', async () => {
  const root = workspace({ 'src/a.py': 'def f():\n    return 1\n' });
  const calls = [];
  const chat = async (system, prompt) => { calls.push(prompt); return 'f returns 1 (src/a.py:1)'; };
  const r = await digest({ paths: ['src/a.py'], question: 'what does f do?' }, { chat, redact: identity, root });
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /=== src\/a\.py ===\n1\| def f\(\):/);
  assert.match(calls[0], /QUESTION: what does f do\?$/);
  assert.strictEqual(r.text, 'f returns 1 (src/a.py:1)');
  assert.strictEqual(r.chunks, 1);
});

test('digest map-reduces large input and skips NONE notes', async () => {
  const body = Array.from({ length: 4000 }, (_, i) => (i === 3500 ? 'FATAL disk full' : `info step ${i}`)).join('\n');
  const root = workspace({ 'run.log': body });
  const prompts = [];
  const chat = async (system, prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith('NOTES:')) return 'Disk full at run.log:3501';
    return prompt.includes('FATAL') ? 'run.log:3501 FATAL disk full' : 'NONE';
  };
  const r = await digest({ paths: ['run.log'], question: 'why did it fail?' }, { chat, redact: identity, root });
  assert.ok(r.chunks > 1);
  assert.strictEqual(prompts.length, r.chunks + 1);
  const reduce = prompts.at(-1);
  assert.strictEqual(reduce.match(/--- part/g).length, 1, 'only the relevant note is combined');
  assert.strictEqual(r.text, 'Disk full at run.log:3501');
});

test('digest with a pattern that matches nothing skips the model', async () => {
  const root = workspace({ 'run.log': 'all good\n' });
  const chat = async () => assert.fail('model should not be called');
  const r = await digest({ paths: ['run.log'], question: 'errors?', pattern: 'error' }, { chat, redact: identity, root });
  assert.match(r.text, /No lines match/);
});

test('digest fails closed when redaction fails', async () => {
  const root = workspace({ 'a.txt': 'x' });
  const chat = async () => 'password=hunter2hunter2';
  const redact = async () => { throw new Error('Redaction unavailable'); };
  await assert.rejects(digest({ paths: ['a.txt'], question: 'q' }, { chat, redact, root }), /Redaction unavailable/);
});

test('pythonRedact hides secrets with dual_ai/privacy.py', async t => {
  let out;
  try {
    out = await pythonRedact('db: postgres://app:S3cretPass@db/x and key sk-ant-abcdefghijklmnopqrstuvwx');
  } catch (e) {
    t.skip(`Python unavailable: ${e.message}`);
    return;
  }
  assert.doesNotMatch(out, /S3cretPass|abcdefghijklmnop/);
  assert.match(out, /\[PASSWORD_1\]/);
});

test('JobQueue runs jobs one at a time and reports position', async () => {
  const q = new JobQueue();
  const order = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const a = q.submit('a', async () => { order.push('a start'); await gate; order.push('a end'); return 1; });
  const b = q.submit('b', async () => { order.push('b start'); return 2; });
  await q.wait(a, 20);
  assert.strictEqual(a.status, 'running');
  assert.strictEqual(b.status, 'queued');
  assert.strictEqual(q.position(b), 1);
  release();
  await q.wait(b, 1000);
  assert.deepStrictEqual(order, ['a start', 'a end', 'b start']);
  assert.strictEqual(b.result, 2);
});

// ── MCP handler ───────────────────────────────────────────────────────────────

async function call(handler, name, args) {
  const resp = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return resp.result;
}

test('tools/list exposes the digest tools', async () => {
  const handler = createHandler({ chat: identity, redact: identity, root: os.tmpdir(), model: 'm' });
  const resp = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = resp.result.tools.map(t => t.name);
  for (const n of ['motkra_digest', 'motkra_result', 'ollama_chat', 'ollama_list_models']) assert.ok(names.includes(n), n);
});

test('motkra_digest returns the answer when it finishes in time', async () => {
  const root = workspace({ 'a.txt': 'hello' });
  const handler = createHandler({ chat: async () => 'says hello (a.txt:1)', redact: identity, root, model: 'gemma' });
  const r = await call(handler, 'motkra_digest', { paths: ['a.txt'], question: 'what?' });
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /^says hello \(a\.txt:1\)\n\n— motkra \(gemma\): read 5 chars in 1 chunk\(s\)/);
});

test('motkra_digest goes to the background and motkra_result collects it', async () => {
  const root = workspace({ 'a.txt': 'hello' });
  let release;
  const gate = new Promise(r => { release = r; });
  const handler = createHandler({ chat: async () => { await gate; return 'late answer'; }, redact: identity, root, model: 'm' });

  const first = await call(handler, 'motkra_digest', { paths: ['a.txt'], question: 'q', wait_seconds: 0 });
  const id = first.content[0].text.match(/job_id: (job-\d+)/)[1];

  const pending = await call(handler, 'motkra_result', { job_id: id, wait_seconds: 0 });
  assert.match(pending.content[0].text, /Still working/);

  release();
  const done = await call(handler, 'motkra_result', { job_id: id, wait_seconds: 5 });
  assert.match(done.content[0].text, /^late answer/);
});

test('motkra_digest reports bad paths and failures as tool errors', async () => {
  const root = workspace({ 'a.txt': 'x' });
  const handler = createHandler({ chat: async () => { throw new Error('Ollama: model not found'); }, redact: identity, root, model: 'm' });
  const bad = await call(handler, 'motkra_digest', { paths: ['../nope.txt'], question: 'q' });
  assert.ok(bad.isError);
  const failed = await call(handler, 'motkra_digest', { paths: ['a.txt'], question: 'q' });
  assert.ok(failed.isError);
  assert.match(failed.content[0].text, /model not found/);
  const unknown = await call(handler, 'motkra_result', { job_id: 'job-999' });
  assert.ok(unknown.isError);
});
