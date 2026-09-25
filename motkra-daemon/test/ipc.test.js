'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const { allowedRequest } = require('../ipc');

const PORT = 7432;

test('local callers without Origin are allowed (VS Code extension)', () => {
  assert.equal(allowedRequest({ host: '127.0.0.1:7432' }, PORT), true);
  assert.equal(allowedRequest({ host: 'localhost:7432' }, PORT), true);
});

test('browser extensions are allowed', () => {
  assert.equal(allowedRequest({ host: '127.0.0.1:7432', origin: 'chrome-extension://abcdefghijklmnop' }, PORT), true);
  assert.equal(allowedRequest({ host: '127.0.0.1:7432', origin: 'moz-extension://1234-5678' }, PORT), true);
});

test('web pages are refused', () => {
  for (const origin of ['https://evil.example', 'http://localhost:3000', 'null', 'chrome-extension://x/evil path']) {
    assert.equal(allowedRequest({ host: '127.0.0.1:7432', origin }, PORT), false, origin);
  }
});

test('foreign Host headers are refused (DNS rebinding)', () => {
  assert.equal(allowedRequest({ host: 'evil.example:7432' }, PORT), false);
  assert.equal(allowedRequest({ host: '127.0.0.1:9999' }, PORT), false);
  assert.equal(allowedRequest({}, PORT), false);
});
