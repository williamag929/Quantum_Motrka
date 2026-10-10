'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { DiskJobs, readJob, writeJob } = require('../disk-jobs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motkra-jobs-'));

// Stand-in for worker.js: records its pid, "works" for spec.ms, then writes a result.
// spec.crash makes it exit without finishing, like a killed worker.
const fakeWorker = path.join(tmp, 'fake-worker.js');
fs.writeFileSync(fakeWorker, `
  const { readJob, writeJob } = require(${JSON.stringify(path.join(__dirname, '..', 'disk-jobs.js'))});
  const file = process.argv[2];
  const job = readJob(file);
  writeJob(file, { ...job, pid: process.pid, status: 'running', progress: 'chunk 1/1' });
  if (job.spec.crash) process.exit(3);
  setTimeout(() => writeJob(file, { ...readJob(file), status: 'done',
    result: { text: 'answer for ' + job.spec.question, chunks: 1, rawChars: 5, seconds: 0 } }), job.spec.ms ?? 0);
`);

const make = dir => new DiskJobs({ dir, worker: fakeWorker });

test('a job started by one server instance is visible to another (the "Unknown job_id" bug)', async () => {
  const dir = path.join(tmp, 'shared');
  const a = make(dir), b = make(dir);
  const job = a.submit('q', null, { question: 'q', ms: 300 });
  assert.match(job.id, /^job-\d{14}-[0-9a-f]{6}$/);
  const seen = b.get(job.id);
  assert.ok(seen, 'instance B must find the job');
  const done = await b.wait(seen, 10_000);
  assert.equal(done.status, 'done');
  assert.equal(done.result.text, 'answer for q');
});

test('ids never repeat across instances', () => {
  const dir = path.join(tmp, 'ids');
  const ids = new Set();
  for (let i = 0; i < 5; i++) {
    ids.add(make(dir).submit('q', null, { question: 'q' }).id);
    ids.add(make(dir).submit('q', null, { question: 'q' }).id);
  }
  assert.equal(ids.size, 10);
});

test('a worker that dies marks its job failed instead of "running" forever', async () => {
  const jobs = make(path.join(tmp, 'crash'));
  const job = jobs.submit('q', null, { question: 'q', crash: true });
  const out = await jobs.wait(job, 10_000);
  assert.equal(out.status, 'failed');
  assert.match(out.error, /stopped before finishing/);
});

test('a job whose worker never started fails after the grace period', () => {
  const dir = path.join(tmp, 'nostart');
  const jobs = make(dir);
  const file = path.join(dir, 'job-20260101000000-abcdef.json');
  writeJob(file, { id: 'job-20260101000000-abcdef', status: 'queued', createdAt: Date.now() - 60_000, spec: {} });
  assert.equal(jobs.get('job-20260101000000-abcdef').status, 'failed');
});

test('unknown or malformed ids are not found', () => {
  const jobs = make(path.join(tmp, 'unknown'));
  assert.equal(jobs.get('job-999'), undefined);
  assert.equal(jobs.get('../../etc/passwd'), undefined);
});

test('position counts unfinished jobs submitted earlier', async () => {
  const dir = path.join(tmp, 'position');
  const jobs = make(dir);
  const first = jobs.submit('a', null, { question: 'a', ms: 2000 });
  await new Promise(r => setTimeout(r, 20));
  const second = jobs.submit('b', null, { question: 'b', ms: 2000 });
  assert.equal(jobs.position(second), 1);
  assert.equal(jobs.position(first), 0);
  await jobs.wait(second, 10_000);
  assert.ok(readJob(path.join(dir, `${second.id}.json`)));
});
