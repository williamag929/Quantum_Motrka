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
