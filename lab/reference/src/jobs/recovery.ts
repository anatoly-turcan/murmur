import type { DatabaseSync } from 'node:sqlite';
import { all, run } from '../db/sql.ts';
import { immediate } from '../db/tx.ts';
import { errorFields, type Logger } from '../log.ts';
import { isOwned } from './claim.ts';
import { applyResult } from './queue.ts';
import type { JobHandlers, JobOutcome, JobRow } from './types.ts';

export const HEARTBEAT_STALE_MS = 5000;

interface WorkerRow {
  id: string;
  pid: number;
  heartbeat_at: number;
}

export function heartbeat(db: DatabaseSync, workerId: string, pid: number, realNow: number): void {
  run(
    db,
    `INSERT INTO worker_instances (id, pid, started_at, heartbeat_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`,
    workerId,
    pid,
    realNow,
    realNow,
  );
}

export function unregister(db: DatabaseSync, workerId: string): void {
  run(db, 'DELETE FROM worker_instances WHERE id = ?', workerId);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function liveWorkers(db: DatabaseSync, realNow: number): Set<string> {
  const rows = all<WorkerRow>(db, 'SELECT id, pid, heartbeat_at FROM worker_instances');
  const live = new Set<string>();
  for (const w of rows) {
    if (w.heartbeat_at >= realNow - HEARTBEAT_STALE_MS && pidAlive(w.pid)) live.add(w.id);
    else run(db, 'DELETE FROM worker_instances WHERE id = ?', w.id);
  }

  return live;
}

function interruptedOutcome(handlers: JobHandlers, db: DatabaseSync, job: JobRow, now: number): JobOutcome {
  const handler = handlers[job.type];
  if (handler?.onInterrupted) return handler.onInterrupted(db, job, now);

  return { result: { status: 'retry', runAt: now, error: 'worker terminated' } };
}

function recoverJob(db: DatabaseSync, handlers: JobHandlers, job: JobRow, now: number): boolean {
  return immediate(db, () => {
    if (!job.locked_by || !isOwned(db, job.id, job.locked_by)) return false;
    const outcome = interruptedOutcome(handlers, db, job, now);
    outcome.apply?.();
    applyResult(db, job, outcome.result, now);

    return true;
  });
}

function orphanedJobs(db: DatabaseSync): JobRow[] {
  const live = liveWorkers(db, Date.now());

  return all<JobRow>(db, `SELECT * FROM jobs WHERE status = 'running'`).filter((j) => !j.locked_by || !live.has(j.locked_by));
}

function recoverAll(db: DatabaseSync, handlers: JobHandlers, now: () => number, log: Logger): number {
  let recovered = 0;
  for (const job of orphanedJobs(db)) {
    try {
      if (recoverJob(db, handlers, job, now())) recovered += 1;
    } catch (err) {
      log.error('recovery failed', { job: job.id, ...errorFields(err) });
    }
  }

  return recovered;
}

export function sweep(db: DatabaseSync, handlers: JobHandlers, now: () => number, log: Logger): number {
  const recovered = immediate(db, () => recoverAll(db, handlers, now, log));
  if (recovered > 0) log.info('recovered interrupted jobs', { count: recovered });

  return recovered;
}
