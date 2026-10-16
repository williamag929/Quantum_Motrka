'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.MOTKRA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-settings-'));
const settings = require('../settings');

const ALL  = { local: true, claude: true, nvidia: true };
const pick = (plan, ctx) => settings.pickProvider(plan, { available: ALL, ...ctx });
const local = { target: 'local', private: false };
const priv  = { target: 'local', private: true };
const cloud = { target: 'cloud', private: false };

test('everything on: the router decides', () => {
  assert.deepEqual(pick(local), { engine: 'gemma' });
  assert.deepEqual(pick(cloud), { engine: 'claude' });
  assert.deepEqual(pick(cloud, { cloudPreference: 'nvidia' }), { engine: 'kimi' });
});

test('Ollama paused: simple questions go to the preferred cloud', () => {
  const av = { ...ALL, local: false };
  assert.deepEqual(pick(local, { available: av }), { engine: 'claude', note: 'Ollama paused' });
  assert.deepEqual(pick(local, { available: av, cloudPreference: 'nvidia' }), { engine: 'kimi', note: 'Ollama paused' });
});

test('Ollama paused: a private conversation is never sent to the cloud', () => {
  for (const av of [{ ...ALL, local: false }, { local: false, claude: true, nvidia: false }]) {
    const r = pick(priv, { available: av });
    assert.ok(r.blocked, JSON.stringify(av));
    assert.match(r.blocked, /private/);
  }
});

test('cloud off: complex questions are answered locally', () => {
  assert.deepEqual(pick(cloud, { available: { local: true, claude: false, nvidia: false } }),
    { engine: 'gemma', note: 'cloud models off: answered locally' });
});

test('Claude off: the other cloud answers, and says when tools are unavailable', () => {
  const av = { local: true, claude: false, nvidia: true };
  assert.deepEqual(pick(cloud, { available: av }), { engine: 'kimi' });
  assert.deepEqual(pick(cloud, { available: av, wantsTools: true }), { engine: 'kimi', note: 'Claude is off: answering without tools' });
});

test('tools prefer Claude even when NVIDIA is the preferred cloud', () => {
  assert.deepEqual(pick(cloud, { cloudPreference: 'nvidia', wantsTools: true }), { engine: 'claude' });
});

test('forced models are respected, and refused (not swapped) when off', () => {
  assert.deepEqual(pick(cloud, { forced: 'kimi' }), { engine: 'kimi' });
  assert.deepEqual(pick(local, { forced: 'claude' }), { engine: 'claude' });
  const r = pick(cloud, { forced: 'gemma', available: { ...ALL, local: false } });
  assert.match(r.blocked, /Ollama \(local\) is turned off/);
});

test('everything off is explained', () => {
  const none = { local: false, claude: false, nvidia: false };
  assert.ok(pick(local, { available: none }).blocked);
  assert.ok(pick(cloud, { available: none }).blocked);
});

test('settings persist, merge partial updates and ignore junk', () => {
  const core = () => { const { providers, cloudPreference } = settings.load(); return { providers, cloudPreference }; };
  assert.deepEqual(core(), { providers: ALL, cloudPreference: 'claude' });
  settings.save({ providers: { local: false } });
  settings.save({ cloudPreference: 'nvidia', providers: { claude: 'yes' } });
  assert.deepEqual(core(), { providers: { local: false, claude: true, nvidia: true }, cloudPreference: 'nvidia' });
  settings.save({ cloudPreference: 'gpt' });
  assert.equal(settings.load().cloudPreference, 'nvidia');
});

test('a provider without its API key is not available', () => {
  const saved = process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  settings.save({ providers: { nvidia: true } });
  assert.equal(settings.available().nvidia, false);
  const row = settings.status().providers.find(p => p.id === 'nvidia');
  assert.equal(row.configured, false);
  assert.equal(row.needs, 'NVIDIA_API_KEY');
  if (saved) process.env.NVIDIA_API_KEY = saved;
});

// ── model and endpoint settings ──────────────────────────────────────────

test('models: defaults, saved override, and bad ids are ignored', () => {
  assert.equal(settings.modelFor('claude'), 'claude-opus-4-7');
  assert.equal(settings.modelFor('nvidia'), 'moonshotai/kimi-k2.6');
  settings.save({ models: { nvidia: 'nvidia/nemotron-3-super-120b-a12b' } });
  assert.equal(settings.modelFor('nvidia'), 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(settings.status().providers.find(p => p.id === 'nvidia').model, 'nvidia/nemotron-3-super-120b-a12b');
  settings.save({ models: { nvidia: 'bad model; rm' } });
  assert.equal(settings.modelFor('nvidia'), 'nvidia/nemotron-3-super-120b-a12b');
  settings.save({ models: { nvidia: '' } });   // empty resets to the default
  assert.equal(settings.modelFor('nvidia'), 'moonshotai/kimi-k2.6');
});

test('endpoint: default is NVIDIA, https or localhost http only', () => {
  assert.equal(settings.endpointFor().baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(settings.endpointFor().apiKeyEnv, 'NVIDIA_API_KEY');
  settings.save({ endpoint: { baseUrl: 'ftp://x' } });
  settings.save({ endpoint: { baseUrl: 'http://example.com/v1' } });
  assert.equal(settings.endpointFor().baseUrl, 'https://integrate.api.nvidia.com/v1');
  settings.save({ endpoint: { baseUrl: 'http://localhost:1234/v1/', apiKeyEnv: 'MY_KEY' } });
  assert.equal(settings.endpointFor().baseUrl, 'http://localhost:1234/v1');
  assert.equal(settings.endpointFor().apiKeyEnv, 'MY_KEY');
  settings.save({ endpoint: { apiKeyEnv: 'not a var' } });
  assert.equal(settings.endpointFor().apiKeyEnv, 'MY_KEY');
});

test('endpoint: the key comes from the environment and is never saved or reported', () => {
  process.env.MY_KEY = 'secret-value-123';
  assert.equal(settings.endpointFor().apiKey, 'secret-value-123');
  const onDisk = fs.readFileSync(path.join(process.env.MOTKRA_DIR, 'settings.json'), 'utf8');
  assert.ok(!onDisk.includes('secret-value-123'));
  assert.ok(!JSON.stringify(settings.status()).includes('secret-value-123'));
  delete process.env.MY_KEY;
});

test('settings written by an older version load with the new defaults', () => {
  fs.writeFileSync(path.join(process.env.MOTKRA_DIR, 'settings.json'),
    JSON.stringify({ providers: { local: true, claude: false, nvidia: true }, cloudPreference: 'nvidia' }));
  const s = settings.load();
  assert.equal(s.providers.claude, false);
  assert.equal(settings.modelFor('nvidia', s), 'moonshotai/kimi-k2.6');
  assert.equal(settings.endpointFor(s).baseUrl, 'https://integrate.api.nvidia.com/v1');
});
