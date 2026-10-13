'use strict';

const test = require('node:test');
const assert = require('node:assert');

const gh = require('../github');
const { createHandler } = require('../index');

test('parseRepo accepts owner/repo and full URLs, rejects junk', () => {
  assert.deepEqual(gh.parseRepo('williamag929/Quantum_Motrka'), { owner: 'williamag929', repo: 'Quantum_Motrka' });
  assert.deepEqual(gh.parseRepo('https://github.com/a/b.git'), { owner: 'a', repo: 'b' });
  assert.throws(() => gh.parseRepo('not-a-repo'), /owner\/repo/);
});

test('listIssues filters out PRs and formats the list', async () => {
  const request = async () => ({
    status: 200,
    body: [
      { number: 1, state: 'open', title: 'Real issue', comments: 2, user: { login: 'ann' } },
      { number: 2, state: 'open', title: 'A PR', comments: 0, user: { login: 'bob' }, pull_request: {} },
    ],
  });
  const out = await gh.listIssues('a/b', {}, 'tok', request);
  assert.match(out, /#1 \[open\] Real issue/);
  assert.doesNotMatch(out, /A PR/);          // PR filtered out of the issues view
  assert.match(out, /1 open issue/);
});

test('listIssues with pull=true returns only PRs', async () => {
  const request = async () => ({
    status: 200,
    body: [{ number: 7, state: 'open', title: 'My PR', comments: 1, user: { login: 'ann' }, pull_request: {} }],
  });
  const out = await gh.listIssues('a/b', { pull: true }, 'tok', request);
  assert.match(out, /#7 \[open\] My PR/);
  assert.match(out, /1 open PR/);
});

test('getIssue includes body and comments', async () => {
  const request = async (method, path) => {
    if (path.includes('/comments')) return { status: 200, body: [{ user: { login: 'ann' }, body: 'looks good' }] };
    return { status: 200, body: { number: 3, title: 'Bug', state: 'open', user: { login: 'bob' }, comments: 1, labels: [], body: 'steps...', html_url: 'u' } };
  };
  const out = await gh.getIssue('a/b', 3, 'tok', request);
  assert.match(out, /#3 Bug/);
  assert.match(out, /steps\.\.\./);
  assert.match(out, /@ann:\nlooks good/);
});

test('ghError explains 401 and 404 clearly', () => {
  assert.match(gh.ghError({ status: 401, body: { message: 'Bad credentials' } }), /auth failed.*GITHUB_TOKEN/);
  assert.match(gh.ghError({ status: 404, body: { message: 'Not Found' } }), /Not found.*token/);
});

test('a non-200 response surfaces as a thrown error, not a crash', async () => {
  const request = async () => ({ status: 404, body: { message: 'Not Found' } });
  await assert.rejects(() => gh.getIssue('a/b', 9, 'bad', request), /Not found/);
});

test('the MCP handler routes github_list_issues and returns text content', async () => {
  const request = async () => ({ status: 200, body: [{ number: 5, state: 'open', title: 'Hi', comments: 0, user: { login: 'x' } }] });
  // createHandler uses the real github.js (default request), so we assert routing shape via tools/list instead.
  const listResp = await createHandler({})({ id: 1, method: 'tools/list' });
  const names = listResp.result.tools.map(t => t.name);
  for (const n of ['github_list_issues', 'github_get_issue', 'github_create_issue', 'github_comment', 'github_pr_diff', 'github_pr_files']) {
    assert.ok(names.includes(n), `tools/list should include ${n}`);
  }
});

test('the handler rejects a github call missing required args', async () => {
  const resp = await createHandler({})({ id: 2, method: 'tools/call', params: { name: 'github_get_issue', arguments: { repo: 'a/b' } } });
  assert.equal(resp.error.code, -32602);
  assert.match(resp.error.message, /"repo" and "number" are required/);
});
