'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { loadProjectRules, mentionsWorktrees } = require('../core/project-rules');

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-rules-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

test('instruction files are loaded, and the rules they point to come along (serpi layout)', () => {
  const root = project({
    'AGENTS.md': 'Reglas: `CLAUDE.md`. Protocolo de coworkers (worktrees): `docs/COWORK.md`.',
    'CLAUDE.md': 'Capas: Api, Domain.',
    'docs/COWORK.md': '## Worktrees y ramas\n- Un agente = un worktree; nunca trabajar en la rama base.',
    'docs/unrelated.md': 'not referenced',
  });
  const r = loadProjectRules(root);
  assert.deepEqual(r.files, ['AGENTS.md', 'CLAUDE.md', 'docs/COWORK.md']);
  assert.match(r.text, /Un agente = un worktree/);
  assert.doesNotMatch(r.text, /not referenced/);
  assert.equal(mentionsWorktrees(r.text), true);
});

test('references outside the project and missing files are ignored', () => {
  const root = project({ 'AGENTS.md': 'See ../secret.md, /etc/x.md and docs/missing.md' });
  assert.deepEqual(loadProjectRules(root).files, ['AGENTS.md']);
});

test('the selected agent file is not repeated', () => {
  const root = project({ 'CLAUDE.md': 'rules', '.github/copilot-instructions.md': 'copilot rules' });
  const r = loadProjectRules(root, [path.join(root, 'CLAUDE.md')]);
  assert.deepEqual(r.files, ['.github/copilot-instructions.md']);
});

test('no instructions means no prompt section', () => {
  assert.deepEqual(loadProjectRules(project({ 'README.md': 'hi' })), { files: [], text: '' });
});

test('large files are capped', () => {
  const root = project({ 'AGENTS.md': 'x'.repeat(100_000) });
  assert.ok(loadProjectRules(root).text.length < 20_000);
});
