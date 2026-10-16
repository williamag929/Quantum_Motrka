'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.MOTKRA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-prov-'));
const { load, pick, settingsFile } = require('../core/provider-settings');

const ALL = { local: true, cloud: true, kimi: true };

test('the router decides when everything is on; NVIDIA preference sends cloud work to Kimi', () => {
  assert.deepEqual(pick('local', { available: ALL }), { model: 'local' });
  assert.deepEqual(pick('cloud', { available: ALL }), { model: 'cloud' });
  assert.deepEqual(pick('cloud', { available: ALL, cloudPreference: 'kimi' }), { model: 'kimi' });
});

test('Ollama paused: local work goes to the preferred cloud', () => {
  assert.deepEqual(pick('local', { available: { ...ALL, local: false }, cloudPreference: 'kimi' }), { model: 'kimi', note: 'Ollama paused' });
});

test('a message with a secret never leaves the machine, even with Ollama paused', () => {
  assert.deepEqual(pick('cloud', { available: ALL, secretLocal: true }), { model: 'local' });
  assert.match(pick('cloud', { available: { ...ALL, local: false }, secretLocal: true }).blocked, /secret/);
});

test('the panel switch is respected, and refused when that provider is off', () => {
  assert.deepEqual(pick('local', { available: ALL, forced: 'kimi' }), { model: 'kimi' });
  assert.match(pick('local', { available: { ...ALL, kimi: false }, forced: 'kimi' }).blocked, /NVIDIA \(Kimi\) is turned off/);
});

test('reads the desktop app settings file and requires API keys', () => {
  const keys = { a: process.env.ANTHROPIC_API_KEY, n: process.env.NVIDIA_API_KEY };
  process.env.ANTHROPIC_API_KEY = 'x';
  delete process.env.NVIDIA_API_KEY;
  fs.writeFileSync(settingsFile(), JSON.stringify({ providers: { local: false, claude: true, nvidia: true }, cloudPreference: 'nvidia' }));
  const got = load();
  assert.deepEqual({ available: got.available, cloudPreference: got.cloudPreference }, { available: { local: false, cloud: true, kimi: false }, cloudPreference: 'kimi' });
  if (keys.a) process.env.ANTHROPIC_API_KEY = keys.a; else delete process.env.ANTHROPIC_API_KEY;
  if (keys.n) process.env.NVIDIA_API_KEY = keys.n;
});

// ── models, endpoint and auto mode (shared ~/.motkra/settings.json) ──────

const { kimiConfig, classifyTask } = require('../core/provider-settings');

test('kimiConfig: defaults, then the model and endpoint saved in the desktop app', () => {
  fs.writeFileSync(settingsFile(), JSON.stringify({}));
  const d = kimiConfig();
  assert.equal(d.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(d.apiKeyEnv, 'NVIDIA_API_KEY');
  fs.writeFileSync(settingsFile(), JSON.stringify({
    models: { nvidia: 'nvidia/nemotron-3-super-120b-a12b' },
    endpoint: { baseUrl: 'http://localhost:1234/v1/', apiKeyEnv: 'MY_KEY' },
  }));
  process.env.MY_KEY = 'abc';
  const c = kimiConfig();
  delete process.env.MY_KEY;
  assert.equal(c.model, 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(c.baseUrl, 'http://localhost:1234/v1');
  assert.equal(c.apiKey, 'abc');
});

test('kimiConfig ignores unsafe values', () => {
  fs.writeFileSync(settingsFile(), JSON.stringify({
    models: { nvidia: 'bad model; rm' }, endpoint: { baseUrl: 'http://example.com/v1', apiKeyEnv: 'not a var' },
  }));
  const c = kimiConfig();
  assert.equal(c.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(c.apiKeyEnv, 'NVIDIA_API_KEY');
  assert.ok(!/ /.test(c.model));
});

test('load exposes mode and tasks using the extension\'s model names', () => {
  fs.writeFileSync(settingsFile(), JSON.stringify({ mode: 'auto', tasks: { chat: 'nvidia', agent: 'claude', quick: 'local' } }));
  const s = load();
  assert.equal(s.mode, 'auto');
  assert.deepEqual(s.tasks, { chat: 'kimi', agent: 'cloud', quick: 'local' });
});

test('classifyTask: short plain text is quick, anything else is chat', () => {
  assert.equal(classifyTask('what is a monad?'), 'quick');
  assert.equal(classifyTask('fix\n```js\nx\n```'), 'chat');
  assert.equal(classifyTask('a '.repeat(30)), 'chat');
});

test('auto mode picks from the task table; a secret still forces local', () => {
  const tasks = { chat: 'kimi', agent: 'cloud', quick: 'local' };
  assert.deepEqual(pick('cloud', { available: ALL, mode: 'auto', tasks, taskKind: 'quick' }), { model: 'local' });
  assert.deepEqual(pick('local', { available: ALL, mode: 'auto', tasks, taskKind: 'chat' }), { model: 'kimi' });
  assert.deepEqual(pick('cloud', { available: ALL, mode: 'auto', tasks, taskKind: 'chat', secretLocal: true }), { model: 'local' });
  assert.deepEqual(pick('cloud', { available: ALL, mode: 'manual', tasks, taskKind: 'quick' }), { model: 'cloud' });
  assert.deepEqual(pick('cloud', { available: ALL, mode: 'auto', tasks, taskKind: 'chat', forced: 'local' }), { model: 'local' });
});

test('auto mode falls back, with a note, when the chosen provider is off', () => {
  const tasks = { chat: 'kimi', agent: 'cloud', quick: 'local' };
  const r = pick('cloud', { available: { ...ALL, kimi: false }, mode: 'auto', tasks, taskKind: 'chat' });
  assert.equal(r.model, 'cloud');
  assert.match(r.note, /NVIDIA \(Kimi\) unavailable/);
});
