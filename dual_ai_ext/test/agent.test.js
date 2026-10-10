'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { executeTool } = require('../agent');

test('file tools refuse paths outside the workspace', async () => {
  const outsidePath = path.resolve(process.cwd(), '..', 'outside-workspace.txt');
  await assert.rejects(
    executeTool('read_file', { path: outsidePath }),
    /File paths must stay inside the workspace/
  );
});

test('file writes require session access and approval of the diff', async () => {
  let accessRequests = 0;
  let diffRequests = 0;
  const target = `motkra-write-test-${process.pid}-${Date.now()}.txt`;

  try {
    const result = await executeTool('write_file', { path: target, content: 'test' }, {
      onWriteAccessRequest: async () => { accessRequests++; return true; },
      onDiffRequest: async () => { diffRequests++; return false; },
    });

    assert.equal(result, `Edit rejected by user: ${target}`);
    assert.equal(accessRequests, 1);
    assert.equal(diffRequests, 1);
    assert.equal(fs.existsSync(path.join(process.cwd(), target)), false);
  } finally {
    const full = path.join(process.cwd(), target);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }
});
