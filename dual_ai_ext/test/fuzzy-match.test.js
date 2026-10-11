'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeWhitespace,
  differsOnlyByWhitespace,
  similarity,
  findClosestLines,
  formatNoMatchHint,
} = require('../core/fuzzy-match');

test('normalizeWhitespace collapses spaces/tabs and CRLF, keeping line structure', () => {
  assert.equal(normalizeWhitespace('a   b\tc  \r\nd'), 'a b c\nd');
});

test('similarity is 1 for identical text and lower for different text', () => {
  assert.equal(similarity('hello world', 'hello world'), 1);
  // shares the "o world"/"e world" tail, so partial but not near-identical
  assert.ok(similarity('hello world', 'goodbye world') > 0.5);
  assert.ok(similarity('hello world', 'goodbye world') < 1);
  assert.equal(similarity('', 'x'), 0);
});

test('differsOnlyByWhitespace is true only when spacing/line-endings differ', () => {
  assert.equal(differsOnlyByWhitespace('foo   bar', 'foo bar'), true);
  assert.equal(differsOnlyByWhitespace('a\r\nb', 'a\nb'), true);
  assert.equal(differsOnlyByWhitespace('totally different', 'foo bar'), false);
  assert.equal(differsOnlyByWhitespace('foo bar', 'foo bar baz'), false); // present → not a "differs" case
});

test('findClosestLines returns the right window with a line number', () => {
  const content = ['line one', 'const x = 1;', 'line three', 'const y = 2;'].join('\n');
  const near = findClosestLines(content, 'const x = 1;', { threshold: 0.3, context: 0 });
  assert.ok(near.length >= 1);
  assert.equal(near[0].text, 'const x = 1;');
  assert.equal(near[0].startLine, 1);
  assert.equal(near[0].firstShownLine, 1); // 0-based internal; +1 when shown to the model
});

test('formatNoMatchHint explains a whitespace-only mismatch and asks to re-read', () => {
  const hint = formatNoMatchHint('const x   = 1;', 'const x = 1;', 'a.js');
  assert.match(hint, /whitespace\/line-endings differ/);
  assert.match(hint, /Re-read the file/);
  assert.match(hint, /a\.js/);
});

test('formatNoMatchHint shows the closest real section with line numbers', () => {
  const content = ['header', 'function add(a, b) {', '  return a + b;', '}'].join('\n');
  // model mangled the body — should still surface the real function
  const hint = formatNoMatchHint('function add(a, b) { return a + b; }', content, 'math.js');
  assert.match(hint, /Closest matching section/);
  assert.match(hint, /\d+\|/); // line-number gutter
  assert.match(hint, /return a \+ b/);
});

test('formatNoMatchHint tells the model to read_file when nothing resembles old_string', () => {
  const hint = formatNoMatchHint('a totally unrelated string', 'function foo() {}', 'z.js');
  assert.match(hint, /No similar text was found/);
  assert.match(hint, /Call read_file/);
});
