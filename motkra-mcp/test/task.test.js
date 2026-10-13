'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { runTask } = require('../task');

// A fake agent loop that drives the callbacks the way runAgent does, so we test the
// harness (auto-approval + transcript) without a network call or API key.
function fakeLoop({ plan }) {
  // plan: array of {tool:'write_file'|'run_command'|'read_file', input, approveResult}
  return async function fakeRunAgent(history, system, onToken, onTool, onDone, onDiffRequest, onUsage, toolOpts) {
    let answer = '';
    for (const step of plan) {
      onTool(step.tool, step.input);
      if (step.tool === 'write_file' || step.tool === 'str_replace') {
        const accepted = await onDiffRequest('diff_1', step.input.path);
        answer += `[${accepted ? 'wrote' : 'refused'} ${step.input.path}] `;
      } else {
        answer += `[${step.tool}] `;
      }
    }
    onToken(answer);
    onDone(answer);
    return answer;
  };
}

test('runTask auto-approves writes and logs every action to the transcript', async () => {
  const loop = fakeLoop({ plan: [
    { tool: 'read_file', input: { path: 'a.js' } },
    { tool: 'write_file', input: { path: 'a.js', content: 'x' } },
    { tool: 'run_command', input: { cmd: 'npm test' } },
  ] });
  const r = await runTask('do the thing', { root: '/tmp', _resolver: () => loop });
  assert.equal(r.ok, true);
  assert.ok(r.answer.includes('wrote a.js'));
  assert.deepEqual(r.toolsUsed, ['read_file', 'write_file', 'run_command']);
  assert.match(r.transcript, /Motkra task: do the thing/);
  assert.match(r.transcript, /▸ read_file a\.js/);
  assert.match(r.transcript, /✓ applied edit: a\.js/);
  assert.match(r.transcript, /--- result ---/);
});

test('runTask passes the workspace root and allowlist through to the loop', async () => {
  let seen;
  const loop = async (h, s, onToken, onTool, onDone, onDiff, onUsage, toolOpts) => {
    seen = toolOpts;
    onToken('done');
  };
  await runTask('goal', { root: '/work', allowedCommands: ['git'], _resolver: () => loop });
  assert.equal(seen.root, '/work');
  assert.deepEqual(seen.allowedCommands, ['git']);
  assert.equal(typeof seen.onActionApproval, 'function');
});

test('runTask reports a loop error as a failed result, not a throw', async () => {
  const loop = async () => { throw new Error('API key missing'); };
  const r = await runTask('goal', { _resolver: () => loop });
  assert.equal(r.ok, false);
  assert.match(r.answer, /API key missing/);
});

test('runTask surfaces a clear error when the agent package cannot be loaded', async () => {
  const r = await runTask('goal', { _resolver: () => { throw new Error('Cannot find module @anthropic-ai/sdk'); } });
  assert.equal(r.ok, false);
  assert.match(r.answer, /Could not load the Motkra agent loop/);
  assert.match(r.answer, /npm install/);
});

test('the MCP handler routes motkra_task and lists it in tools/list', async () => {
  const { createHandler } = require('../index');
  const list = await createHandler({})({ id: 1, method: 'tools/list' });
  assert.ok(list.result.tools.some(t => t.name === 'motkra_task'));
  const missing = await createHandler({})({ id: 2, method: 'tools/call', params: { name: 'motkra_task', arguments: {} } });
  assert.equal(missing.error.code, -32602);
  assert.match(missing.error.message, /"goal" is required/);
});
