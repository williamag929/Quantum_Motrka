'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const { lineSplitter, parseEvent } = require('../voice');

test('lineSplitter joins lines split across chunks', () => {
  const lines = [];
  const feed = lineSplitter(l => lines.push(l));
  feed('{"event":"transcript","text":"ho');
  feed('la"}\r\n{"event":"rea');
  assert.deepStrictEqual(lines, ['{"event":"transcript","text":"hola"}']);
  feed('dy"}\n\n');
  assert.strictEqual(lines.length, 2);
});

test('lineSplitter handles Buffer chunks with UTF-8 text', () => {
  const lines = [];
  lineSplitter(l => lines.push(l))(Buffer.from('¿Qué hora es?\n', 'utf8'));
  assert.deepStrictEqual(lines, ['¿Qué hora es?']);
});

test('parseEvent accepts worker events and ignores anything else', () => {
  assert.deepStrictEqual(parseEvent('{"event":"transcript","text":"hola"}'), { event: 'transcript', text: 'hola' });
  assert.strictEqual(parseEvent('Downloading model...'), null);
  assert.strictEqual(parseEvent('{"text":"no event"}'), null);
  assert.strictEqual(parseEvent('null'), null);
});
