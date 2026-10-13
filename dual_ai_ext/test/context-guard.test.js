'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  estimateTokens,
  estimateMessagesTokens,
  compactMessages,
  guardContext,
  DEFAULT_WINDOW,
  RESERVE,
} = require('../core/context-guard');

test('estimateTokens is roughly chars/4', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  assert.equal(estimateTokens(''), 0);
});

test('estimateMessagesTokens counts strings and block arrays', () => {
  const msgs = [
    { role: 'system', content: 'x'.repeat(400) },                          // 100
    { role: 'user', content: [{ type: 'text', text: 'y'.repeat(400) }] },  // 100
  ];
  assert.equal(estimateMessagesTokens(msgs), 200);
});

test('compactMessages leaves short histories untouched', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
  ];
  const { messages, droppedChars } = compactMessages(msgs, { keepTail: 8 });
  assert.deepEqual(messages, msgs);
  assert.equal(droppedChars, 0);
});

test('compactMessages collapses old Anthropic tool_result blocks but keeps goal + tail', () => {
  const big = 'B'.repeat(2000);
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'THE GOAL' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: big }] },
    { role: 'assistant', content: 'recent work' },
    { role: 'user', content: 'more' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: 'done' },
  ];
  const { messages, droppedChars } = compactMessages(msgs, { keepTail: 4, maxCharsPerBlock: 500 });

  // goal preserved verbatim
  assert.equal(messages[0].content[0].text, 'THE GOAL');
  // an old tool_result collapsed to a note, id preserved for API pairing
  const collapsed = messages[2].content[0];
  assert.match(collapsed.content, /compacted/);
  assert.equal(collapsed.tool_use_id, 't1');
  // the tail (last 4) untouched
  assert.equal(messages[messages.length - 1].content, 'done');
  assert.ok(droppedChars > 0);
});

test('compactMessages collapses old Kimi role:tool string messages', () => {
  const big = 'C'.repeat(2000);
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'GOAL' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
    { role: 'tool', tool_call_id: 'c1', content: big },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2' }] },
    { role: 'tool', tool_call_id: 'c2', content: big },
    { role: 'assistant', content: 'recent' },
    { role: 'user', content: 'u' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'tail' },
  ];
  const { messages, droppedChars } = compactMessages(msgs, { keepTail: 4, maxCharsPerBlock: 500 });
  assert.equal(messages[0].content, 'sys');       // system preserved
  assert.equal(messages[1].content, 'GOAL');      // goal preserved
  assert.match(messages[3].content, /compacted/); // old tool collapsed
  assert.equal(messages[3].tool_call_id, 'c1');
  assert.equal(messages[messages.length - 1].content, 'tail');
  assert.ok(droppedChars > 0);
});

test('guardContext does not compact a small conversation', () => {
  const msgs = [{ role: 'user', content: 'small' }];
  const g = guardContext(msgs);
  assert.equal(g.needsCompact, false);
  assert.equal(g.messages, msgs); // same reference, no copy
  assert.ok(g.tokens < g.budget);
});

test('guardContext compacts once the budget is exceeded', () => {
  // Use a tiny window so a modest payload crosses the threshold.
  const big = 'D'.repeat(4000);
  const msgs = [
    { role: 'user', content: 'GOAL' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'r', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'r', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: big }] },
    { role: 'assistant', content: 'x' },
    { role: 'user', content: 'y' },
    { role: 'assistant', content: 'z' },
    { role: 'user', content: 'w' },
    { role: 'assistant', content: 'end' },
  ];
  const g = guardContext(msgs, { window: 1500, reserve: 100, keepTail: 4 });
  assert.equal(g.needsCompact, true);
  assert.ok(g.tokens < DEFAULT_WINDOW);
  assert.ok(g.droppedChars > 0);
  // budget reflects window - reserve
  assert.equal(g.budget, 1400);
});
