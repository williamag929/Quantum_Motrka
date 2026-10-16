'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const { subscribeTerminalOutput } = require('../ambient/terminal-monitor');

const tick = () => new Promise(r => setImmediate(r));
const disposable = () => ({ disposed: false, dispose() { this.disposed = true; } });

test('uses the stable shell-integration API and streams each command\'s output', async () => {
  let onStart;
  const win = { onDidStartTerminalShellExecution: cb => { onStart = cb; return disposable(); } };
  const got = [];
  const sub = subscribeTerminalOutput(win, text => got.push(text));
  assert.ok(sub);
  async function* stream() { yield 'building…\n'; yield 'Error: boom\n'; }
  onStart({ execution: { read: stream } });
  await tick(); await tick();
  assert.deepEqual(got, ['building…\n', 'Error: boom\n']);
});

test('a failing output stream does not throw into VS Code', async () => {
  let onStart;
  const win = { onDidStartTerminalShellExecution: cb => { onStart = cb; return disposable(); } };
  subscribeTerminalOutput(win, () => {});
  async function* bad() { throw new Error('stream closed'); }
  assert.doesNotThrow(() => onStart({ execution: { read: bad } }));
  await tick(); await tick();
});

test('falls back to the proposed API when the stable one is missing', () => {
  const got = [];
  let fire;
  const win = { onDidWriteTerminalData: cb => { fire = cb; return disposable(); } };
  assert.ok(subscribeTerminalOutput(win, t => got.push(t)));
  fire({ data: 'Traceback' });
  assert.deepEqual(got, ['Traceback']);
});

test('the proposed API throwing "CANNOT use API proposal" is not fatal: no monitor, no crash', () => {
  const win = {
    get onDidWriteTerminalData() { throw new Error("Extension 'local.motkra' CANNOT use API proposal: terminalDataWriteEvent."); },
  };
  let sub;
  assert.doesNotThrow(() => { sub = subscribeTerminalOutput(win, () => {}); });
  assert.equal(sub, null);
});

test('no terminal API at all: returns null', () => {
  assert.equal(subscribeTerminalOutput({}, () => {}), null);
});
