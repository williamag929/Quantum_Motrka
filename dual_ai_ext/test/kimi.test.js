'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { streamKimi, reasoningOf } = require('../clients/kimi');

test('Kimi reports a missing NVIDIA API key without making a request', async () => {
  const key = process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  try {
    await assert.rejects(
      streamKimi([], () => {}),
      /NVIDIA_API_KEY is not set in dual_ai\/\.env/
    );
  } finally {
    if (key === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = key;
  }
});

test('reasoningOf reads the reasoning chunk from either provider field name', () => {
  assert.equal(reasoningOf({ reasoning_content: 'step one' }), 'step one');
  assert.equal(reasoningOf({ reasoning: 'step two' }), 'step two');
  // content is the answer, not reasoning — never confuse the two
  assert.equal(reasoningOf({ content: 'the answer' }), '');
  assert.equal(reasoningOf({}), '');
});

test('streamKimi uses the model, endpoint and key saved in the desktop app', async () => {
  const http = require('http');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hola' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-extkimi-'));
  const prevDir = process.env.MOTKRA_DIR;
  process.env.MOTKRA_DIR = dir;
  process.env.EXT_TEST_KEY = 'k-ext';
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    models: { nvidia: 'acme/model-x' },
    endpoint: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'EXT_TEST_KEY' },
  }));
  try {
    const text = await streamKimi([{ role: 'user', content: 'hi' }], () => {});
    assert.equal(text, 'hola');
    assert.equal(seen[0].url, '/v1/chat/completions');
    assert.equal(seen[0].auth, 'Bearer k-ext');
    assert.equal(seen[0].body.model, 'acme/model-x');
  } finally {
    server.close();
    delete process.env.EXT_TEST_KEY;
    if (prevDir === undefined) delete process.env.MOTKRA_DIR; else process.env.MOTKRA_DIR = prevDir;
  }
});
