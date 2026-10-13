'use strict';

/**
 * Digest jobs that survive the MCP server. A client may run several server instances or
 * restart one mid-job (Claude Desktop does both), so in-memory jobs were lost with
 * "Unknown job_id". Here every job is a JSON file in ~/.motkra/mcp-jobs, and each digest
 * runs in its own detached worker process (worker.js). Any instance can report on any job.
 * Workers take a lock file so jobs still run one at a time across all instances.
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const KEEP_MS = 24 * 60 * 60 * 1000;   // finished jobs are kept a day
const POLL_MS = 500;
const START_GRACE_MS = 30_000;          // a worker that never recorded its pid by then did not start

function jobsDir() {
  return process.env.MOTKRA_JOBS_DIR ?? path.join(process.env.MOTKRA_DIR ?? path.join(os.homedir(), '.motkra'), 'mcp-jobs');
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readJob(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Write atomically so readers never see half a file. */
function writeJob(file, job) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job));
  fs.renameSync(tmp, file);
}

class DiskJobs {
  /** @param {object} env  extra environment for workers (MOTKRA_ROOT etc.) */
  constructor({ dir = jobsDir(), worker = path.join(__dirname, 'worker.js'), env = {} } = {}) {
    this.dir = dir;
    this.worker = worker;
    this.env = env;
    fs.mkdirSync(dir, { recursive: true });
    this._prune();
  }

  file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  /** `run` is ignored: the worker process runs `spec` (see worker.js). */
  submit(label, _run, spec) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const id = `job-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    const job = { id, label, status: 'queued', progress: '', result: null, error: null, createdAt: Date.now(), spec };
    writeJob(this.file(id), job);
    const child = spawn(process.execPath, [this.worker, this.file(id)], {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...this.env },
    });
    child.unref();   // the worker records its own pid in the job file
    return job;
  }

  get(id) {
    if (!/^job-[\w-]+$/.test(String(id))) return undefined;
    const job = readJob(this.file(id));
    if (!job) return undefined;
    // A worker that died (killed, crashed, reboot) must not leave a job "running" forever.
    const unfinished = job.status === 'queued' || job.status === 'running';
    const dead = job.pid ? !isAlive(job.pid) : Date.now() - job.createdAt > START_GRACE_MS;
    if (unfinished && dead) {
      job.status = 'failed';
      job.error = 'the worker process stopped before finishing; run the digest again';
      writeJob(this.file(id), job);
    }
    return job;
  }

  async wait(job, ms) {
    const end = Date.now() + ms;
    let cur = this.get(job.id) ?? job;
    while ((cur.status === 'queued' || cur.status === 'running') && Date.now() < end) {
      await new Promise(r => setTimeout(r, Math.min(POLL_MS, Math.max(0, end - Date.now()))));
      cur = this.get(job.id) ?? cur;
    }
    return cur;
  }

  /** Unfinished jobs created before this one. */
  position(job) {
    return this._all().filter(j => j.id !== job.id && j.createdAt <= job.createdAt &&
      (j.status === 'queued' || j.status === 'running')).length;
  }

  _all() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter(n => /^job-.+\.json$/.test(n)); } catch {}
    return names.map(n => readJob(path.join(this.dir, n))).filter(Boolean);
  }

  _prune() {
    const cutoff = Date.now() - KEEP_MS;
    for (const j of this._all()) {
      if ((j.status === 'done' || j.status === 'failed') && j.createdAt < cutoff) {
        try { fs.unlinkSync(this.file(j.id)); } catch {}
      }
    }
  }
}

module.exports = { DiskJobs, readJob, writeJob, isAlive, jobsDir };
