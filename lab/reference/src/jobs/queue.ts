import type { DatabaseSync } from 'node:sqlite';
import { insert, one, run } from '../db/sql.ts';
import type { JobResult, JobRow, JobType } from './types.ts';

export interface EnqueueInput {
  type: JobType;
  payload?: unknown;
  runAt: number;
  now: number;
  queueKey?: string;
}

export interface JobRef {
  id: number;
  runAt: number;
}

function queueTail(db: DatabaseSync, queueKey: string): { pos: number; runAt: number | null } {
  const row = one<{ pos: number | null; run_at: number | null }>(
    db,
    `SELECT (SELECT max(queue_pos) FROM jobs WHERE queue_key = ?1) AS pos,
            (SELECT max(run_at) FROM jobs WHERE queue_key = ?1 AND status = 'pending') AS run_at`,
    queueKey,
  );

  return { pos: row?.pos ?? 0, runAt: row?.run_at ?? null };
}

export function enqueue(db: DatabaseSync, input: EnqueueInput): JobRef {
  const payload = JSON.stringify(input.payload ?? {});
  if (!input.queueKey) {
    const id = insert(
      db,
      `INSERT INTO jobs (type, status, payload, run_at, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?, ?)`,
      input.type,
      payload,
      input.runAt,
      input.now,
      input.now,
    );

    return { id, runAt: input.runAt };
  }
  const tail = queueTail(db, input.queueKey);
  const runAt = Math.max(input.runAt, tail.runAt ?? input.runAt);
  const id = insert(
    db,
    `INSERT INTO jobs (type, status, payload, run_at, queue_key, queue_pos, created_at, updated_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)`,
    input.type,
    payload,
    runAt,
    input.queueKey,
    tail.pos + 1,
    input.now,
    input.now,
  );

  return { id, runAt };
}

export function bumpFollowers(db: DatabaseSync, queueKey: string, queuePos: number, runAt: number): void {
  run(
    db,
    `UPDATE jobs SET run_at = max(run_at, ?) WHERE queue_key = ? AND status = 'pending' AND queue_pos > ?`,
    runAt,
    queueKey,
    queuePos,
  );
}

export function moveToEnd(db: DatabaseSync, jobId: number, now: number): JobRef {
  const job = one<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job?.queue_key) {
    run(db, `UPDATE jobs SET status = 'pending', run_at = ?, locked_by = NULL, updated_at = ? WHERE id = ?`, now, now, jobId);

    return { id: jobId, runAt: now };
  }
  const tail = queueTail(db, job.queue_key);
  const runAt = Math.max(now, tail.runAt ?? now);
  run(
    db,
    `UPDATE jobs SET status = 'pending', run_at = ?, queue_pos = ?, locked_by = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
    runAt,
    tail.pos + 1,
    now,
    jobId,
  );

  return { id: jobId, runAt };
}

export function applyResult(db: DatabaseSync, job: JobRow, result: JobResult, now: number): void {
  if (result.status === 'succeeded') {
    run(db, `UPDATE jobs SET status = 'succeeded', locked_by = NULL, updated_at = ? WHERE id = ?`, now, job.id);

    return;
  }
  if (result.status === 'dead') {
    run(db, `UPDATE jobs SET status = 'dead', last_error = ?, locked_by = NULL, updated_at = ? WHERE id = ?`, result.error, now, job.id);

    return;
  }
  run(
    db,
    `UPDATE jobs SET status = 'pending', run_at = ?, last_error = ?, locked_by = NULL, updated_at = ? WHERE id = ?`,
    result.runAt,
    result.error,
    now,
    job.id,
  );
  if (job.queue_key !== null && job.queue_pos !== null) bumpFollowers(db, job.queue_key, job.queue_pos, result.runAt);
}

const GENERIC_DELAYS_MS = [10_000, 60_000, 300_000, 1_800_000];

export function genericFailure(attemptCount: number, now: number, error: string): JobResult {
  if (attemptCount > GENERIC_DELAYS_MS.length) return { status: 'dead', error };

  return { status: 'retry', runAt: now + GENERIC_DELAYS_MS[Math.max(0, attemptCount - 1)], error };
}
