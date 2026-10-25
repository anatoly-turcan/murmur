import type { DatabaseSync } from 'node:sqlite';
import { run } from '../db/sql.ts';
import { succeeded, type JobHandler } from './types.ts';

const RATE_WINDOW_RETENTION_MS = 120_000;

export function purgeExpired(db: DatabaseSync, now: number): void {
  run(db, 'DELETE FROM idempotency_keys WHERE expires_at <= ?', now);
  run(db, 'DELETE FROM rate_limit_counters WHERE window_start < ?', now - RATE_WINDOW_RETENTION_MS);
}

export const maintenanceJob: JobHandler = {
  async run(_job, ctx) {
    return succeeded({ apply: () => purgeExpired(ctx.db, ctx.now()) });
  },
};
