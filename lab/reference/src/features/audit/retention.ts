import type { DatabaseSync } from 'node:sqlite';
import { one, run } from '../../db/sql.ts';
import { enqueue } from '../../jobs/queue.ts';
import { succeeded, type JobContext, type JobHandler } from '../../jobs/types.ts';

const DAY_MS = 86_400_000;
const BATCH = 2_000;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function deleteBatch(db: DatabaseSync, cutoff: number): number {
  return run(db, `DELETE FROM audit_entries WHERE rowid IN (SELECT rowid FROM audit_entries WHERE occurred_at < ? LIMIT ${BATCH})`, cutoff);
}

export async function purgeExpiredAudit(ctx: JobContext): Promise<number> {
  const cutoff = ctx.now() - ctx.config.auditRetentionDays * DAY_MS;
  let total = 0;
  for (;;) {
    const deleted = ctx.begin(() => deleteBatch(ctx.db, cutoff));
    total += deleted;
    if (deleted < BATCH) return total;
    await yieldToEventLoop();
  }
}

export const auditRetentionJob: JobHandler = {
  async run(_job, ctx) {
    const purged = await purgeExpiredAudit(ctx);
    if (purged > 0) ctx.log.info('audit retention', { purged });

    return succeeded();
  },
};

function hasOpenRetention(db: DatabaseSync, createdAfter: number): boolean {
  return (
    one(
      db,
      `SELECT 1 AS x FROM jobs WHERE type = 'audit_retention' AND (status IN ('pending', 'running') OR created_at > ?) LIMIT 1`,
      createdAfter,
    ) !== undefined
  );
}

export function enqueueAuditRetention(db: DatabaseSync, now: number, manual: boolean): number {
  if (hasOpenRetention(db, manual ? Number.MAX_SAFE_INTEGER : now - DAY_MS)) return 0;
  enqueue(db, { type: 'audit_retention', runAt: now, now });

  return 1;
}
