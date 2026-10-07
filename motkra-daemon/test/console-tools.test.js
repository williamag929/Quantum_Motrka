'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-console-'));
process.env.MOTKRA_DIR = path.join(tmp, 'motkra-data');
const consoleTools = require('../console-tools');
const fsTools      = require('../fs-tools');

const cwd = path.join(tmp, 'project');
fs.mkdirSync(cwd, { recursive: true });

function asker(scope) {
  const calls = [];
  return { calls, ask: async req => { calls.push(req); return scope; } };
}

test.beforeEach(() => { consoleTools.revokeAll(); fsTools.revokeAll(); });

test('tokenize keeps quoted words and refuses chaining or redirection', () => {
  assert.deepEqual(consoleTools.tokenize('git commit -m "fix: a b"'), ['git', 'commit', '-m', 'fix: a b']);
  assert.deepEqual(consoleTools.tokenize(`python -c 'print(1)'`), ['python', '-c', 'print(1)']);
  assert.deepEqual(consoleTools.tokenize('node "" x'), ['node', '', 'x']);
  for (const bad of ['git status & del x', 'a | b', 'a; b', 'a > out.txt', 'a < in', 'a `b`', 'a\nb', 'git "unclosed']) {
    assert.throws(() => consoleTools.tokenize(bad), undefined, bad);
  }
  assert.deepEqual(consoleTools.tokenize('git log "--format=%h | %s"'), ['git', 'log', '--format=%h | %s']); // quoted is literal
});

test('classify', () => {
  const cases = {
    'git status': 'read', 'git log --oneline': 'read', 'node --version': 'read', 'pip list': 'read', 'whoami': 'read',
    'npm test': 'run', 'python app.py': 'run', 'git commit -m x': 'run', 'git remote add origin url': 'run',
    'git push': 'destructive', 'git reset --hard': 'destructive', 'git branch -D old': 'destructive',
    'reg delete HKCU\\x': 'destructive', 'powershell -c x': 'destructive', 'cmd /c dir': 'destructive',
    'npm publish': 'destructive', 'C:\\Windows\\System32\\shutdown.exe /s': 'destructive',
  };
  for (const [cmd, tier] of Object.entries(cases)) {
    assert.equal(consoleTools.classify(consoleTools.tokenize(cmd)), tier, cmd);
  }
});

test('child processes never see API keys', () => {
  const env = consoleTools.childEnv({ PATH: 'p', ANTHROPIC_API_KEY: 'sk', NVIDIA_API_KEY: 'n', GITHUB_TOKEN: 't', HOME: 'h' });
  assert.deepEqual(env, { PATH: 'p', HOME: 'h' });
});

test('batch programs refuse arguments that could escape cmd.exe quoting', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => consoleTools.spawnArgs('C:\\x\\npm.cmd', ['run', 'a"&calc']));
  assert.throws(() => consoleTools.spawnArgs('C:\\x\\npm.cmd', ['%PATH%']));
  const spec = consoleTools.spawnArgs('C:\\x\\npm.cmd', ['run', 'my script']);
  assert.equal(spec.verbatim, true);
  assert.equal(spec.args.at(-1), '"C:\\x\\npm.cmd run "my script""');
});

test('built-ins and unknown programs are explained, not run', () => {
  assert.throws(() => consoleTools.prepare({ command: 'dir', cwd }), /built-in/);
  assert.throws(() => consoleTools.prepare({ command: 'definitely-not-a-program-xyz', cwd }), /not found/);
  assert.throws(() => consoleTools.prepare({ command: 'node --version', cwd: 'relative' }), /absolute/);
  assert.throws(() => consoleTools.prepare({ command: 'node --version', cwd: path.join(os.homedir(), '.ssh') }));
});

test('read-only command runs without asking inside a folder allowed for reading', async () => {
  await fsTools.runTool('list_directory', { path: cwd }, { ask: async () => 'session' });
  const { ask, calls } = asker('deny');
  const out = await consoleTools.runCommand({ command: 'node --version', cwd }, { ask });
  assert.equal(calls.length, 0);
  assert.match(out, /exit code 0/);
  assert.match(out, /v\d+\./);
});

test('other commands ask with the exact command; denial throws and nothing runs', async () => {
  const marker = path.join(cwd, 'ran.txt');
  const { ask, calls } = asker('deny');
  await assert.rejects(
    consoleTools.runCommand({ command: `node -e "require('fs').writeFileSync('ran.txt','x')"`, cwd }, { ask }),
    /did not approve/
  );
  assert.equal(calls[0].op, 'run');
  assert.equal(calls[0].tier, 'run');
  assert.match(calls[0].command, /^node -e /);
  assert.equal(fs.existsSync(marker), false);
});

test('a session approval covers the same command in that folder only', async () => {
  const first = asker('session');
  await consoleTools.runCommand({ command: 'node -e 1', cwd }, first);
  const again = asker('deny');
  await consoleTools.runCommand({ command: 'node -e 1', cwd }, again);
  assert.equal(again.calls.length, 0);
  await assert.rejects(consoleTools.runCommand({ command: 'node -e 2', cwd }, again), /did not approve/);
});

test('destructive commands ask every time and only offer once/deny', async () => {
  const { ask, calls } = asker('once');
  await consoleTools.runCommand({ command: 'git push --dry-run', cwd }, { ask }).catch(() => {});
  await consoleTools.runCommand({ command: 'git push --dry-run', cwd }, { ask }).catch(() => {});
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].scopes, ['once', 'deny']);
  await assert.rejects(consoleTools.runCommand({ command: 'git push', cwd }, asker('always')), /did not approve/);
});

test('npm (a .cmd program) runs through the safe batch path', { skip: process.platform !== 'win32' }, async () => {
  const out = await consoleTools.runCommand({ command: 'npm --version', cwd }, asker('once'));
  assert.match(out, /exit code 0/);
  assert.match(out, /\d+\.\d+\.\d+/);
});

test('long commands are stopped at the timeout', async () => {
  const t0 = Date.now();
  const out = await consoleTools.runCommand(
    { command: 'node -e "setTimeout(()=>{}, 60000)"', cwd, timeout_seconds: 1 }, asker('once'));
  assert.match(out, /timed out after 1s/);
  assert.ok(Date.now() - t0 < 10000);
});

test('environment secrets do not reach the command output', async () => {
  process.env.MOTKRA_TEST_API_KEY = 'sk-should-not-leak';
  const out = await consoleTools.runCommand(
    { command: 'node -e "console.log(JSON.stringify(process.env))"', cwd }, asker('once'));
  delete process.env.MOTKRA_TEST_API_KEY;
  assert.ok(!out.includes('sk-should-not-leak'));
});
