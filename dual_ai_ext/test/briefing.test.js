'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const briefing = require('../core/briefing');

// ── collectCommits: real git in a temp repo ──────────────────────────────────
function tempRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-brief-')));
  const run = c => { try { require('child_process').execSync(c, { cwd: dir }); } catch { /* ignore */ } };
  run('git init -q');
  run('git config user.email t@t'); run('git config user.name t');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
  run('git add -A'); run('git commit -q -m "first commit"');
  return dir;
}

test('collectCommits returns recent commit subjects and never throws on a non-repo', () => {
  const dir = tempRepo();
  const out = briefing.collectCommits(dir);
  assert.match(out, /first commit/);
  // a plain temp dir is not a git repo → returns empty, not an exception
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-norepo-')));
  assert.equal(briefing.collectCommits(empty), '');
});

test('detectRepo parses owner/name from a github remote, empty when none', () => {
  const dir = tempRepo();
  // fresh repo, no remote → empty, no throw
  assert.equal(briefing.detectRepo(dir), '');
  // add a github remote → parsed
  require('child_process').execSync('git remote add origin https://github.com/acme/widgets.git', { cwd: dir });
  assert.equal(briefing.detectRepo(dir), 'acme/widgets');
});

// ── maybeRunBriefing gating (no network; synthesize stubbed via cfg with no work) ──
function fakeCfg(values) {
  return { get: (k, d) => (k in values ? values[k] : d) };
}

test('briefing does nothing when the setting is off (default)', async () => {
  const dir = tempRepo();
  const shown = [];
  const provider = { _postSystemMsg: t => shown.push(t) };
  const ctx = { globalState: { get: () => null, update: () => {} } };
  const r = await briefing.maybeRunBriefing(provider, ctx, {
    cfg: fakeCfg({ dailyBriefing: false }), now: new Date('2026-01-02T09:00:00'), root: dir,
  });
  assert.equal(r, null);
  assert.equal(shown.length, 0);
});

test('briefing is skipped before 8am', async () => {
  const dir = tempRepo();
  const ctx = { globalState: { get: () => null, update: () => {} } };
  const r = await briefing.maybeRunBriefing({ _postSystemMsg() {} }, ctx, {
    cfg: fakeCfg({ dailyBriefing: true }), now: new Date('2026-01-02T06:30:00'), root: dir,
  });
  assert.equal(r, null);
});

test('briefing runs at most once per day (lastBriefing date)', async () => {
  const dir = tempRepo();
  const day = '2026-01-02';
  let updated = null;
  const ctx = { globalState: { get: () => day, update: (k, v) => { updated = v; } } };
  // already shown today → no-op even though setting is on and it's 9am
  const r = await briefing.maybeRunBriefing({ _postSystemMsg() {} }, ctx, {
    cfg: fakeCfg({ dailyBriefing: true }), now: new Date(`${day}T09:00:00`), root: dir,
  });
  assert.equal(r, null);
  assert.equal(updated, null);   // never re-wrote the date
});

test('briefing with nothing to say marks today done and shows nothing (happy path)', async () => {
  // setting on, after 8am, fresh state, but no commits and no token → no message,
  // yet it still records today so it won't try again until tomorrow.
  const notARepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-empty-')));
  const day = '2026-01-02';
  const shown = [];
  let updated = null;
  const ctx = { globalState: { get: () => null, update: (k, v) => { updated = v; } } };
  const r = await briefing.maybeRunBriefing({ _postSystemMsg: t => shown.push(t) }, ctx, {
    cfg: fakeCfg({ dailyBriefing: true, githubToken: '' }),
    now: new Date(`${day}T09:00:00`),
    root: notARepo,
  });
  assert.equal(r, null);
  assert.equal(shown.length, 0);
  assert.equal(updated, day);    // recorded so it runs once/day
});
