import type { Sqlite } from './types.ts';

export interface ClaimedJob {
  readonly id: string;
  readonly contract: string;
  readonly input: string;
  readonly attempt: number;
  readonly groupKey: string | null;
  readonly claim: string;
}

export interface NewJob {
  readonly id: string;
  readonly contract: string;
  readonly input: string;
  readonly runAt: number;
  readonly dedupeKey: string | null;
  readonly groupKey: string | null;
  readonly now: number;
}

export interface ExpiredJob {
  readonly id: string;
  readonly contract: string;
  readonly attempt: number;
  readonly error: string;
}

export interface ClaimRequest {
  readonly contracts: readonly string[];
  readonly busy: readonly string[];
  readonly now: number;
  readonly limit: number;
  readonly lockedUntil: (contract: string) => number;
  readonly attempts: (contract: string) => number;
  readonly claim: () => string;
}

export interface ClaimResult {
  readonly claimed: ClaimedJob[];
  readonly expired: ExpiredJob[];
}

export const JOBS_SCHEMA = `CREATE TABLE IF NOT EXISTS murmur_jobs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  contract TEXT NOT NULL,
  input TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  run_at INTEGER NOT NULL,
  locked_until INTEGER,
  claim TEXT,
  dedupe_key TEXT,
  group_key TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS murmur_jobs_dedupe ON murmur_jobs (dedupe_key)
  WHERE state = 'pending' AND dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS murmur_jobs_due ON murmur_jobs (state, run_at);
CREATE TABLE IF NOT EXISTS murmur_schedules (name TEXT PRIMARY KEY, due INTEGER NOT NULL);`;

const INSERT = `INSERT OR IGNORE INTO murmur_jobs
  (id, contract, input, state, attempt, run_at, dedupe_key, group_key, created_at)
  VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`;

const ELIGIBLE = `SELECT j.id, j.contract, j.input, j.attempt, j.state, j.group_key AS groupKey FROM murmur_jobs AS j
  WHERE j.contract IN (SELECT value FROM json_each(?))
    AND j.id NOT IN (SELECT value FROM json_each(?))
    AND ((j.state = 'pending' AND j.run_at <= ?) OR (j.state = 'running' AND j.locked_until <= ?))
    AND (j.group_key IS NULL OR NOT EXISTS (
      SELECT 1 FROM murmur_jobs AS e
      WHERE e.group_key = j.group_key AND e.seq < j.seq AND e.state IN ('pending', 'running')))
  ORDER BY j.run_at, j.seq
  LIMIT ?`;

const CLAIM = `UPDATE murmur_jobs SET state = 'running', attempt = attempt + 1, claim = ?, locked_until = ?
  WHERE id = ?`;

const FINISH = 'DELETE FROM murmur_jobs WHERE id = ? AND claim = ?';

const BURY = `UPDATE murmur_jobs SET state = 'dead', claim = NULL, locked_until = NULL, error = ?
  WHERE id = ? AND claim = ?`;

const EXPIRE = `UPDATE murmur_jobs SET state = 'dead', claim = NULL, locked_until = NULL, error = ?
  WHERE id = ?`;

const RESCHEDULE = `UPDATE OR IGNORE murmur_jobs
  SET state = 'pending', claim = NULL, locked_until = NULL, run_at = ?, error = ?, attempt = attempt - ?
  WHERE id = ? AND claim = ?`;

const LEASE = `INSERT INTO murmur_schedules (name, due) VALUES (?, ?)
  ON CONFLICT (name) DO UPDATE SET due = excluded.due WHERE murmur_schedules.due < excluded.due
  RETURNING name`;

const COUNTS = 'SELECT state, count(*) AS n FROM murmur_jobs GROUP BY state';

type EligibleRow = Omit<ClaimedJob, 'claim'> & { readonly state: string };

export async function insertJob(sql: Sqlite, job: NewJob): Promise<boolean> {
  const result = await sql.run(
    INSERT,
    job.id,
    job.contract,
    job.input,
    job.runAt,
    job.dedupeKey,
    job.groupKey,
    job.now,
  );

  return result.changes > 0;
}

function eligible(sql: Sqlite, request: ClaimRequest, limit: number): Promise<EligibleRow[]> {
  return sql.all<EligibleRow>(
    ELIGIBLE,
    JSON.stringify(request.contracts),
    JSON.stringify(request.busy),
    request.now,
    request.now,
    limit,
  );
}

function exhausted(row: EligibleRow, request: ClaimRequest): boolean {
  return row.state === 'running' && row.attempt >= request.attempts(row.contract);
}

async function expire(tx: Sqlite, row: EligibleRow, result: ClaimResult): Promise<void> {
  const error = `claim expired after ${row.attempt} attempts`;
  await tx.run(EXPIRE, error, row.id);
  result.expired.push({ id: row.id, contract: row.contract, attempt: row.attempt, error });
}

async function claimRow(
  tx: Sqlite,
  row: EligibleRow,
  request: ClaimRequest,
  result: ClaimResult,
): Promise<void> {
  const claim = request.claim();
  await tx.run(CLAIM, claim, request.lockedUntil(row.contract), row.id);
  const { state: _state, ...job } = row;
  result.claimed.push({ ...job, attempt: row.attempt + 1, claim });
}

export async function claimJobs(sql: Sqlite, request: ClaimRequest): Promise<ClaimResult> {
  if ((await eligible(sql, request, 1)).length === 0) {
    return { claimed: [], expired: [] };
  }

  return sql.transaction(async (tx) => {
    const result: ClaimResult = { claimed: [], expired: [] };
    for (const row of await eligible(tx, request, request.limit)) {
      if (exhausted(row, request)) {
        await expire(tx, row, result);
      } else {
        await claimRow(tx, row, request, result);
      }
    }

    return result;
  });
}

export async function finishJob(sql: Sqlite, job: ClaimedJob): Promise<void> {
  await sql.run(FINISH, job.id, job.claim);
}

export async function buryJob(sql: Sqlite, job: ClaimedJob, error: string): Promise<void> {
  await sql.run(BURY, error, job.id, job.claim);
}

export async function rescheduleJob(
  sql: Sqlite,
  job: ClaimedJob,
  change: { readonly runAt: number; readonly error: string | null; readonly refund: boolean },
): Promise<void> {
  const result = await sql.run(
    RESCHEDULE,
    change.runAt,
    change.error,
    change.refund ? 1 : 0,
    job.id,
    job.claim,
  );

  if (result.changes === 0) {
    await sql.run(FINISH, job.id, job.claim);
  }
}

export async function leaseSchedule(sql: Sqlite, name: string, due: number): Promise<boolean> {
  return (await sql.get(LEASE, name, due)) !== undefined;
}

export async function countJobs(sql: Sqlite): Promise<{ pending: number; running: number; dead: number }> {
  const rows = await sql.all<{ state: string; n: number }>(COUNTS);
  const of = (state: string) => rows.find((row) => row.state === state)?.n ?? 0;

  return { pending: of('pending'), running: of('running'), dead: of('dead') };
}
