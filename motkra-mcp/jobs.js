'use strict';

/**
 * Background jobs. The local model handles one request at a time, so jobs run one
 * after another; callers wait on a job for a bounded time and pick it up later.
 */

const MAX_KEPT = 50;

class JobQueue {
  constructor() {
    this.jobs = new Map();
    this.next = 1;
    this.tail = Promise.resolve();
  }

  /** Queue `run(job)`; returns the job. `run` may set job.progress while it works. */
  submit(label, run) {
    const job = {
      id: `job-${this.next++}`,
      label,
      status: 'queued',
      progress: '',
      result: null,
      error: null,
      createdAt: Date.now(),
    };
    let settle;
    job.done = new Promise(r => { settle = r; });
    this.jobs.set(job.id, job);
    this.tail = this.tail.then(async () => {
      job.status = 'running';
      try {
        job.result = await run(job);
        job.status = 'done';
      } catch (e) {
        job.error = e.message;
        job.status = 'failed';
      }
      settle();
    });
    this._prune();
    return job;
  }

  get(id) {
    return this.jobs.get(id);
  }

  /** Wait up to `ms` for the job to finish; returns the job either way. */
  async wait(job, ms) {
    if (ms > 0) {
      let timer;
      await Promise.race([job.done, new Promise(r => { timer = setTimeout(r, ms); })]);
      clearTimeout(timer);
    }
    return job;
  }

  /** Jobs ahead of this one in the queue. */
  position(job) {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j === job) break;
      if (j.status === 'queued' || j.status === 'running') n++;
    }
    return n;
  }

  _prune() {
    const finished = [...this.jobs.values()].filter(j => j.status === 'done' || j.status === 'failed');
    for (const j of finished.slice(0, Math.max(0, finished.length - MAX_KEPT))) this.jobs.delete(j.id);
  }
}

module.exports = { JobQueue };
