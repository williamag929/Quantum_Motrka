#!/usr/bin/env node
'use strict';

/**
 * Runs one digest job, detached from the MCP server that started it:
 *   node worker.js <job file>
 * Progress, result and errors are written back to the job file (see disk-jobs.js).
 * A lock file keeps jobs one at a time across every server instance, because the
 * local model gains nothing from running two at once on this hardware.
 */

const fs   = require('fs');
const path = require('path');

const { digest, pythonRedact } = require('./digest');
const { digestChat } = require('./ollama');
const { readJob, writeJob, isAlive } = require('./disk-jobs');

const file = process.argv[2];
const lock = path.join(path.dirname(file), '.lock');

function update(patch) {
  const job = readJob(file);
  if (job) writeJob(file, { ...job, ...patch });
}

async function acquireLock() {
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = parseInt(fs.readFileSync(lock, 'utf8'), 10);
      if (!isAlive(holder)) { try { fs.unlinkSync(lock); } catch {} continue; }   // stale lock
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

function releaseLock() {
  try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch {}
}

async function main() {
  const job = readJob(file);
  if (!job) process.exit(1);
  update({ pid: process.pid });
  await acquireLock();
  try {
    update({ status: 'running', progress: 'starting' });
    const result = await digest(job.spec, {
      chat: digestChat,
      redact: pythonRedact,
      root: process.env.MOTKRA_ROOT ?? process.cwd(),
      onProgress: progress => update({ progress }),
    });
    update({ status: 'done', result, finishedAt: Date.now() });
  } catch (e) {
    update({ status: 'failed', error: e.message, finishedAt: Date.now() });
  } finally {
    releaseLock();
  }
}

process.on('exit', releaseLock);
main();
