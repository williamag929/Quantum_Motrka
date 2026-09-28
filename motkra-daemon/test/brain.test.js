'use strict';

const test   = require('node:test');
const assert = require('node:assert');

process.env.MOTKRA_BRAIN_PORT = '7499'; // keep clear of a brain the user may be running
const brain = require('../brain');

test('StreamRestorer restores placeholders split across chunks', () => {
  const r = new brain.StreamRestorer({ '[PASSWORD_1]': 'hunter2' });
  const out = ['use [PASS', 'WORD_1', '] now [not a placeholder'].map(c => r.feed(c)).join('') + r.flush();
  assert.equal(out, 'use hunter2 now [not a placeholder');
});

test('restoreDeep restores every string in a tool input', () => {
  const secrets = { '[API_KEY_1]': 'sk-real' };
  assert.deepEqual(
    brain.restoreDeep({ path: 'cfg.py', content: 'KEY = "[API_KEY_1]"', lines: [1, '[API_KEY_1]'] }, secrets),
    { path: 'cfg.py', content: 'KEY = "sk-real"', lines: [1, 'sk-real'] }
  );
});

test('plan resolves to null when the brain is down', async () => {
  assert.equal(await brain.plan([{ role: 'user', content: 'hola' }]), null);
});

test('real Python brain: redacts for the cloud and keeps personal turns local', { timeout: 60000 }, async t => {
  if (!(await brain.start())) return t.skip('Python brain could not start');
  t.after(() => brain.stop());

  const cloud = await brain.plan([{ role: 'user', content: 'my db is postgres://admin:hunter2secret@db/app, write code to connect' }], 'claude');
  assert.equal(cloud.target, 'cloud');
  assert.ok(!JSON.stringify(cloud.messages).includes('hunter2secret'));
  assert.equal(brain.restore(cloud.messages[0].content, cloud.secrets).includes('hunter2secret'), true);

  const personal = await brain.plan([
    { role: 'user', content: 'Mi psiquiatra me subió la sertralina a 100 mg', private: true },
    { role: 'assistant', content: '…', private: true },
    { role: 'user', content: 'Write a Python function that checks for palindromes' },
  ]);
  assert.equal(personal.target, 'local');
  assert.equal(personal.private, true);

  const tool = await brain.redact('API_KEY=sk-proj-FAKE1234567890abcdefghij', cloud.secrets);
  assert.ok(!tool.text.includes('FAKE1234567890'));
  assert.ok(Object.keys(tool.secrets).length > Object.keys(cloud.secrets).length);
});
