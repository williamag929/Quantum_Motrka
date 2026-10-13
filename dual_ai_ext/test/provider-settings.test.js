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
  assert.deepEqual(load(), { available: { local: false, cloud: true, kimi: false }, cloudPreference: 'kimi' });
  if (keys.a) process.env.ANTHROPIC_API_KEY = keys.a; else delete process.env.ANTHROPIC_API_KEY;
  if (keys.n) process.env.NVIDIA_API_KEY = keys.n;
});
