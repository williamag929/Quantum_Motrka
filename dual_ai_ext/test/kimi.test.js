'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { streamKimi } = require('../clients/kimi');

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
