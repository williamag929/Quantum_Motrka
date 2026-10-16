'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.MOTKRA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-kimi-'));
const settings = require('../settings');
const kimi     = require('../kimi');

/** A fake OpenAI-compatible server; `handler(req, body, res)` answers each request. */
function serve(handler) {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') }); handler(req, res); });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      requests, close: () => new Promise(r => server.close(r)),
      url: `http://127.0.0.1:${server.address().port}/v1`,
    }));
  });
}

const sse = (res, ...pieces) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const p of pieces) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};

test('streamKimi posts to the saved endpoint with the saved model and key', async () => {
  const srv = await serve((req, res) => sse(res, 'Hola', ' mundo'));
  process.env.TEST_KEY_A = 'key-a';
  settings.save({ endpoint: { baseUrl: srv.url, apiKeyEnv: 'TEST_KEY_A' }, models: { nvidia: 'acme/model-1' } });
  const got = [];
  const text = await kimi.streamKimi([{ role: 'user', content: 'hi' }], 'be brief', t => got.push(t));
  await srv.close();
  assert.equal(text, 'Hola mundo');
  assert.deepEqual(got, ['Hola', ' mundo']);
  const r = srv.requests[0];
  assert.equal(r.url, '/v1/chat/completions');
  assert.equal(r.headers.authorization, 'Bearer key-a');
  assert.equal(r.body.model, 'acme/model-1');
  assert.match(r.body.messages[0].content, /Instructions:\nbe brief/);   // system folded into the user turn
});

test('testModel reports a retired model with the provider\'s message', async () => {
  const srv = await serve((req, res) => {
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 410, detail: "The model 'acme/old' has reached its end of life" }));
  });
  process.env.TEST_KEY_B = 'key-b';
  settings.save({ endpoint: { baseUrl: srv.url, apiKeyEnv: 'TEST_KEY_B' }, models: { nvidia: 'acme/old' } });
  const r = await kimi.testModel('nvidia');
  await srv.close();
  assert.equal(r.ok, false);
  assert.equal(r.status, 410);
  assert.match(r.message, /end of life/);
});

test('testModel names the missing key variable', async () => {
  delete process.env.TEST_KEY_C;
  settings.save({ endpoint: { baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'TEST_KEY_C' } });
  const r = await kimi.testModel('nvidia');
  assert.equal(r.ok, false);
  assert.match(r.message, /TEST_KEY_C/);
});

test('testModel succeeds on a working model and sends one token', async () => {
  const srv = await serve((req, res) => sse(res, 'ok'));
  process.env.TEST_KEY_D = 'key-d';
  settings.save({ endpoint: { baseUrl: srv.url, apiKeyEnv: 'TEST_KEY_D' }, models: { nvidia: 'acme/model-2' } });
  const r = await kimi.testModel('nvidia');
  await srv.close();
  assert.equal(r.ok, true);
  assert.equal(srv.requests[0].body.max_tokens, 1);
});

test('testModel for providers without a test yet says so', async () => {
  const r = await kimi.testModel('claude');
  assert.equal(r.ok, false);
  assert.match(r.message, /not available/);
});
