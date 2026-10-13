'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const guard = require('../core/branch-guard');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();

function repo(branch = 'main') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-guard-'));
  const root = path.join(parent, 'api');
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', branch);
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return fs.realpathSync(root);
}

test('a protected branch is refused', () => {
  const root = repo('main');
  const r = guard.checkWrite(root);
  assert.equal(r.ok, false);
  assert.match(r.reason, /`main` is protected/);
});

test('a feature branch is fine, unless the rules require a worktree', () => {
  const root = repo('fundacion');
  assert.equal(guard.checkWrite(root).ok, true);
  const r = guard.checkWrite(root, { requireWorktree: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /main checkout \(branch `fundacion`\)/);
});

test('Motkra creates its own worktree + branch, and writing there is allowed', () => {
  const root = repo('fundacion');
  const info = guard.checkWrite(root, { requireWorktree: true }).info;
  const plan = guard.suggestWorktree(info, 'Implementar R51 auxiliar');
  assert.equal(plan.branch, 'motkra/implementar-r51-auxiliar');
  assert.equal(plan.dir, path.join(path.dirname(root), 'wt', 'api-motkra'));
  const dir = guard.createWorktree(info, plan);
  const there = guard.checkWrite(dir, { requireWorktree: true });
  assert.equal(there.ok, true);
  assert.equal(there.info.branch, 'motkra/implementar-r51-auxiliar');
  assert.equal(git(root, 'branch', '--show-current'), 'fundacion', 'the main checkout is untouched');

  // A second task reuses the same worktree on a new branch.
  guard.createWorktree(info, { ...plan, branch: 'motkra/otra-tarea' });
  assert.equal(git(dir, 'branch', '--show-current'), 'motkra/otra-tarea');
});

test('outside a git repo there is nothing to guard', () => {
  assert.equal(guard.checkWrite(fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-nogit-'))).ok, true);
});

test('mutating git commands are recognised', () => {
  assert.equal(guard.isMutatingGit(['git', 'commit', '-m', 'x']), true);
  assert.equal(guard.isMutatingGit(['git.exe', 'checkout', 'main']), true);
  assert.equal(guard.isMutatingGit(['git', 'status']), false);
  assert.equal(guard.isMutatingGit(['npm', 'commit']), false);
});

test('the worktree name comes from the project rules when they give one', () => {
  const declared = 'Motkra: `C:\\projects\\serpi\\wt\\api-motkra` (ramas motkra/<tarea>)';
  assert.equal(guard.worktreeNameFromRules(declared), 'api-motkra');
  const siblings = '- Claude: `C:\\projects\\serpi\\wt\\api-claude`\n- Copilot: `C:\\projects\\serpi\\wt\\api-copilot`';
  assert.equal(guard.worktreeNameFromRules(siblings), 'api-motkra');
  assert.equal(guard.worktreeNameFromRules('no worktree layout here'), null);

  // The folder goes next to the repo on THIS machine, whatever drive the rules mention.
  const info = { mainTop: path.join('D:', 'Projects', 'serpi', 'serpi-api'), branch: 'fundacion' };
  assert.equal(guard.suggestWorktree(info, 'x', siblings).dir, path.join('D:', 'Projects', 'serpi', 'wt', 'api-motkra'));
  assert.equal(guard.suggestWorktree(info, 'x', '').dir, path.join('D:', 'Projects', 'serpi', 'wt', 'serpi-api-motkra'));
});
