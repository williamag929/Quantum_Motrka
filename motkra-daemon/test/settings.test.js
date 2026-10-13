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
  assert.deepEqual(settings.load(), { providers: ALL, cloudPreference: 'claude' });
  settings.save({ providers: { local: false } });
  settings.save({ cloudPreference: 'nvidia', providers: { claude: 'yes' } });
  assert.deepEqual(settings.load(), { providers: { local: false, claude: true, nvidia: true }, cloudPreference: 'nvidia' });
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
