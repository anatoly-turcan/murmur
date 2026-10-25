import type { DatabaseSync } from 'node:sqlite';
import { one, placeholders, run } from '../db/sql.ts';
import { immediate } from '../db/tx.ts';
import type { JobRow, JobType } from './types.ts';

const UNBLOCKED = `(j.queue_key IS NULL OR NOT EXISTS (
  SELECT 1 FROM jobs o WHERE o.queue_key = j.queue_key AND o.id <> j.id
    AND (o.status = 'running' OR (o.status = 'pending' AND o.queue_pos < j.queue_pos))))`;

export interface DueCounts {
  pending: number;
  running: number;
  dead: number;
}

function nextClaimable(db: DatabaseSync, now: number, types: readonly JobType[]): JobRow | undefined {
  return one<JobRow>(
    db,
    `SELECT j.* FROM jobs j
      WHERE j.status = 'pending' AND j.run_at <= ? AND j.type IN (${placeholders(types.length)}) AND ${UNBLOCKED}
      ORDER BY j.run_at, j.id LIMIT 1`,
    now,
    ...types,
  );
}

export function claimNext(db: DatabaseSync, workerId: string, now: number, types: readonly JobType[]): JobRow | null {
  if (types.length === 0) return null;

  return immediate(db, () => {
    const job = nextClaimable(db, now, types);
    if (!job) return null;
    run(
      db,
      `UPDATE jobs SET status = 'running', attempt_count = attempt_count + 1, locked_by = ?, locked_at = ?, updated_at = ?
        WHERE id = ?`,
      workerId,
      Date.now(),
      now,
      job.id,
    );

    return { ...job, status: 'running', attempt_count: job.attempt_count + 1, locked_by: workerId };
  });
}

export function countDue(db: DatabaseSync, now: number): DueCounts {
  const counts = one<DueCounts>(
    db,
    `SELECT (SELECT count(*) FROM jobs j WHERE j.status = 'pending' AND j.run_at <= ? AND ${UNBLOCKED}) AS pending,
            (SELECT count(*) FROM jobs WHERE status = 'running') AS running,
            (SELECT count(*) FROM jobs WHERE status = 'dead') AS dead`,
    now,
  );

  return { pending: counts?.pending ?? 0, running: counts?.running ?? 0, dead: counts?.dead ?? 0 };
}

export function isOwned(db: DatabaseSync, jobId: number, workerId: string): boolean {
  return one(db, `SELECT 1 AS x FROM jobs WHERE id = ? AND status = 'running' AND locked_by = ?`, jobId, workerId) !== undefined;
}
