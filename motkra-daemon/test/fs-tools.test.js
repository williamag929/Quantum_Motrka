'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-fs-'));
process.env.MOTKRA_DIR = path.join(tmp, 'motkra-data');
const fsTools = require('../fs-tools');

const project = path.join(tmp, 'project');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.writeFileSync(path.join(project, 'README.md'), '# Demo');
fs.writeFileSync(path.join(project, 'src', 'app.py'), 'print("hi")');
fs.writeFileSync(path.join(project, '.env'), 'API_KEY=secret');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'private.txt'), 'nope');

function asker(scope) {
  const calls = [];
  const ask = async req => { calls.push(req); return scope; };
  return { ask, calls };
}

test.beforeEach(() => fsTools.revokeAll());

test('denied access throws and nothing is read', async () => {
  const { ask, calls } = asker('deny');
  await assert.rejects(fsTools.runTool('read_file', { path: path.join(project, 'README.md') }, { ask }), /denied/);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].op, 'read');
});

test('a session grant covers the folder and its subfolders without asking again', async () => {
  const { ask, calls } = asker('session');
  const listing = await fsTools.runTool('list_directory', { path: project }, { ask });
  assert.match(listing, /README\.md/);
  assert.match(listing, /src\//);
  assert.strictEqual(await fsTools.runTool('read_file', { path: path.join(project, 'src', 'app.py') }, { ask }), 'print("hi")');
  assert.strictEqual(calls.length, 1);
});

test('allow once does not persist', async () => {
  const { ask, calls } = asker('once');
  await fsTools.runTool('read_file', { path: path.join(project, 'README.md') }, { ask });
  await fsTools.runTool('read_file', { path: path.join(project, 'README.md') }, { ask });
  assert.strictEqual(calls.length, 2);
});

test('always is saved to disk and can be forgotten', async () => {
  const { ask } = asker('always');
  await fsTools.runTool('list_directory', { path: project }, { ask });
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.MOTKRA_DIR, 'permissions.json'), 'utf8'));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(fsTools.listGrants()[0].scope, 'always');
  fsTools.revokeAll();
  assert.deepStrictEqual(fsTools.listGrants(), []);
});

test('a read grant does not allow writing', async () => {
  await fsTools.runTool('list_directory', { path: project }, asker('session'));
  const { ask, calls } = asker('deny');
  await assert.rejects(fsTools.runTool('write_file', { path: path.join(project, 'new.txt'), content: 'x' }, { ask }), /denied/);
  assert.strictEqual(calls[0].op, 'write');
  assert.ok(!fs.existsSync(path.join(project, 'new.txt')));
});

test('.env files are never shared, even inside a granted folder', async () => {
  const { ask, calls } = asker('always');
  await assert.rejects(fsTools.runTool('read_file', { path: path.join(project, '.env') }, { ask }), /never shares/);
  assert.strictEqual(calls.length, 0);
});

test('a grant does not reach sibling folders', async () => {
  await fsTools.runTool('list_directory', { path: project }, asker('session'));
  const { ask, calls } = asker('deny');
  await assert.rejects(fsTools.runTool('read_file', { path: path.join(outside, 'private.txt') }, { ask }), /denied/);
  assert.strictEqual(calls.length, 1);
});

test('a symlink inside a granted folder cannot escape it', async t => {
  const link = path.join(project, 'escape');
  try { fs.symlinkSync(outside, link, 'junction'); } catch { t.skip('symlinks not permitted here'); return; }
  await fsTools.runTool('list_directory', { path: project }, asker('session'));
  const { ask, calls } = asker('deny');
  await assert.rejects(fsTools.runTool('read_file', { path: path.join(link, 'private.txt') }, { ask }), /denied/);
  assert.strictEqual(calls.length, 1);
});

test('relative paths are rejected', async () => {
  await assert.rejects(fsTools.runTool('read_file', { path: 'README.md' }, asker('always')), /absolute/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
