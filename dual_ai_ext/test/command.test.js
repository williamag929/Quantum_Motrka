'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const { tokenize, childEnv, runAllowed } = require('../core/command');

const opts = { cwd: process.cwd(), allowed: ['git', 'node', 'npm'], timeoutMs: 10000 };

test('chaining, pipes and redirection never reach a shell', async () => {
  for (const cmd of ['git status & del /s /q *', 'git status && calc', 'git log | more', 'node x > out.txt', 'git status; calc']) {
    assert.match(await runAllowed(cmd, opts), /^Error: ".+" is not supported/, cmd);
  }
});

test('the allowlist is checked on the program actually run', async () => {
  assert.match(await runAllowed('calc', opts), /not in motkra.allowedCommands/);
  assert.match(await runAllowed('C:\Windows\System32\calc.exe', opts), /not in motkra.allowedCommands/);
});

test('allowed programs run, including .cmd ones like npm', async () => {
  assert.match(await runAllowed('node --version', opts), /^v\d+\./);
  assert.match(await runAllowed('npm --version', opts), /^\d+\.\d+\.\d+/);
});

test('batch arguments that could escape cmd.exe quoting are refused', { skip: process.platform !== 'win32' }, async () => {
  assert.match(await runAllowed('npm run "a&calc"', opts), /not allowed for a batch program/);
});

test('quoted arguments stay together and API keys are not inherited', async () => {
  assert.deepEqual(tokenize('git commit -m "a b"'), ['git', 'commit', '-m', 'a b']);
  assert.deepEqual(childEnv({ PATH: 'p', ANTHROPIC_API_KEY: 'x' }), { PATH: 'p' });
});
