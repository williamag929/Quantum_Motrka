'use strict';

const test = require('node:test');
const assert = require('node:assert');
const gh = require('../core/github');

test('parseRepo accepts owner/repo and URLs, rejects junk', () => {
  assert.deepEqual(gh.parseRepo('williamag929/Quantum_Motrka'), { owner: 'williamag929', repo: 'Quantum_Motrka' });
  assert.deepEqual(gh.parseRepo('https://github.com/a/b.git'), { owner: 'a', repo: 'b' });
  assert.throws(() => gh.parseRepo('nope'), /owner\/repo/);
});

test('listIssues filters out PRs from the issues view', async () => {
  const request = async () => ({ status: 200, body: [
    { number: 1, state: 'open', title: 'Real issue', comments: 0, user: { login: 'a' } },
    { number: 2, state: 'open', title: 'A PR', comments: 0, user: { login: 'b' }, pull_request: {} },
  ]});
  const out = await gh.listIssues('a/b', {}, 'tok', request);
  assert.match(out, /#1 \[open\] Real issue/);
  assert.doesNotMatch(out, /A PR/);
});

test('getIssue includes body and comments', async () => {
  const request = async (method, p) => p.includes('/comments')
    ? { status: 200, body: [{ user: { login: 'a' }, body: 'nice' }] }
    : { status: 200, body: { number: 3, title: 'Bug', state: 'open', user: { login: 'b' }, comments: 1, labels: [], body: 'steps', html_url: 'u' } };
  const out = await gh.getIssue('a/b', 3, 'tok', request);
  assert.match(out, /#3 Bug/);
  assert.match(out, /steps/);
  assert.match(out, /@a:\nnice/);
});

test('listPRFiles lists changed files with their patches', async () => {
  const request = async () => ({ status: 200, body: [
    { status: 'modified', filename: 'x.js', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
  ]});
  const out = await gh.listPRFiles('a/b', 9, 'tok', request);
  assert.match(out, /modified  x\.js  \(\+3\/-1\)/);
  assert.match(out, /\+b/);
});

test('errors explain 401/404 and surface as throws', async () => {
  assert.match(gh.ghError({ status: 401, body: { message: 'Bad creds' } }), /motkra\.githubToken/);
  const req = async () => ({ status: 404, body: { message: 'Not Found' } });
  await assert.rejects(() => gh.getIssue('a/b', 1, 'bad', req), /Not found/);
});
