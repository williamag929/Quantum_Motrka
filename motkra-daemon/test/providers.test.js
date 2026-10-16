'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.MOTKRA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-prov-'));
const settings  = require('../settings');
const providers = require('../providers');

/** Fake API: `routes` maps "METHOD /path" to [status, body]; records what it received. */
function serve(routes) {
  return new Promise(resolve => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      const [status, body] = routes[`${req.method} ${req.url}`] ?? [404, { error: 'no route' }];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => resolve({
      seen, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}

test('local: lists the models Ollama has and tests that the chosen one is installed', async () => {
  const srv = await serve({ 'GET /api/tags': [200, { models: [{ name: 'gemma4:e2b' }, { name: 'qwen3:4b' }] }] });
  process.env.OLLAMA_HOST = '127.0.0.1';
  process.env.OLLAMA_PORT = String(srv.port);
  try {
    assert.deepEqual(await providers.listModels('local'), { ok: true, models: ['gemma4:e2b', 'qwen3:4b'] });
    settings.save({ models: { local: 'qwen3:4b' } });
    assert.equal((await providers.testModel('local')).ok, true);
    settings.save({ models: { local: 'llama9:70b' } });
    const missing = await providers.testModel('local');
    assert.equal(missing.ok, false);
    assert.match(missing.message, /ollama pull llama9:70b/);
  } finally {
    await srv.close();
    delete process.env.OLLAMA_HOST; delete process.env.OLLAMA_PORT;
    settings.save({ models: { local: '' } });
  }
});

test('local: Ollama not running is reported, not thrown', async () => {
  process.env.OLLAMA_HOST = '127.0.0.1';
  process.env.OLLAMA_PORT = '9';
  try {
    const r = await providers.listModels('local');
    assert.equal(r.ok, false);
    assert.match(r.message, /Ollama/);
  } finally { delete process.env.OLLAMA_HOST; delete process.env.OLLAMA_PORT; }
});

test('claude: lists models and tests the chosen one with the key in a header', async () => {
  const srv = await serve({
    'GET /v1/models?limit=100': [200, { data: [{ id: 'claude-opus-4-7' }, { id: 'claude-sonnet-5-5' }] }],
    'GET /v1/models/claude-opus-4-7': [200, { id: 'claude-opus-4-7' }],
    'GET /v1/models/claude-gone': [404, { error: { message: 'model: claude-gone' } }],
  });
  process.env.ANTHROPIC_BASE_URL = srv.url;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    assert.deepEqual(await providers.listModels('claude'), { ok: true, models: ['claude-opus-4-7', 'claude-sonnet-5-5'] });
    assert.equal(srv.seen[0].headers['x-api-key'], 'sk-test');
    assert.equal((await providers.testModel('claude')).ok, true);
    settings.save({ models: { claude: 'claude-gone' } });
    const gone = await providers.testModel('claude');
    assert.equal(gone.ok, false);
    assert.equal(gone.status, 404);
    assert.match(gone.message, /claude-gone/);
  } finally {
    await srv.close();
    delete process.env.ANTHROPIC_BASE_URL; delete process.env.ANTHROPIC_API_KEY;
    settings.save({ models: { claude: '' } });
  }
});

test('claude: a missing key names the variable', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const r = await providers.listModels('claude');
  assert.equal(r.ok, false);
  assert.match(r.message, /ANTHROPIC_API_KEY/);
});

test('nvidia: lists the OpenAI-compatible /models of the saved endpoint', async () => {
  const srv = await serve({ 'GET /v1/models': [200, { data: [{ id: 'a/one' }, { id: 'b/two' }] }] });
  process.env.PROV_TEST_KEY = 'nv-key';
  settings.save({ endpoint: { baseUrl: `${srv.url}/v1`, apiKeyEnv: 'PROV_TEST_KEY' } });
  try {
    assert.deepEqual(await providers.listModels('nvidia'), { ok: true, models: ['a/one', 'b/two'] });
    assert.equal(srv.seen[0].headers.authorization, 'Bearer nv-key');
  } finally { await srv.close(); delete process.env.PROV_TEST_KEY; }
});

test('an unknown provider is rejected', async () => {
  assert.equal((await providers.listModels('bogus')).ok, false);
  assert.equal((await providers.testModel('bogus')).ok, false);
});
