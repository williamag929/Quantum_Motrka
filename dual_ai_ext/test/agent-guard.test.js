'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { executeTool } = require('../agent');

const dirs = () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-agent-')));
  const main = path.join(base, 'main'), wt = path.join(base, 'wt');
  fs.mkdirSync(main); fs.mkdirSync(wt);
  fs.writeFileSync(path.join(main, 'a.txt'), 'old');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'old');
  return { main, wt };
};
const approveDiff = async () => true;

test('a write the guard redirects lands in the worktree, not in the main checkout', async () => {
  const { main, wt } = dirs();
  const asked = [];
  const out = await executeTool('write_file', { path: 'a.txt', content: 'new' }, {
    root: main, onDiffRequest: approveDiff,
    onWriteAccessRequest: async target => { asked.push(target); return { ok: true, root: wt, message: 'moved to worktree' }; },
  });
  assert.deepEqual(asked, [path.join(main, 'a.txt')]);
  assert.equal(fs.readFileSync(path.join(main, 'a.txt'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'new');
  assert.match(out, /moved to worktree/);
});

test('a refused write changes nothing and tells the model why', async () => {
  const { main } = dirs();
  const out = await executeTool('str_replace', { path: 'a.txt', old_text: 'old', new_text: 'new' }, {
    root: main, onDiffRequest: approveDiff,
    onWriteAccessRequest: async () => ({ ok: false, message: 'Not written: the branch `main` is protected.' }),
  });
  assert.match(out, /protected/);
  assert.equal(fs.readFileSync(path.join(main, 'a.txt'), 'utf8'), 'old');
});

test('git commands that change the repo go through the guard; read-only ones do not', async () => {
  const { main } = dirs();
  const asked = [];
  const opts = { root: main, allowedCommands: ['git'], onWriteAccessRequest: async t => { asked.push(t); return { ok: false, message: 'refused' }; } };
  assert.equal(await executeTool('run_command', { cmd: 'git commit -m x' }, opts), 'refused');
  await executeTool('run_command', { cmd: 'git status' }, opts);
  assert.deepEqual(asked, [main]);
});

test('without a guard, writes are denied (as before)', async () => {
  const { main } = dirs();
  const out = await executeTool('write_file', { path: 'b.txt', content: 'x' }, { root: main, onDiffRequest: approveDiff });
  assert.match(out, /Write access denied/);
  assert.equal(fs.existsSync(path.join(main, 'b.txt')), false);
});
