import type { DatabaseSync } from 'node:sqlite';
import { all } from '../../db/sql.ts';
import { enqueue } from '../../jobs/queue.ts';
import type { SchedulerRule } from '../../slices/types.ts';
import { localDate, localTimeMs } from '../../time/zones.ts';
import type { Id } from '../../ids/uuid.ts';

export const DIGEST_HOUR = 8;

export interface DigestJobPayload {
  user_id: Id;
  date: string;
  timezone: string;
}

export function localDateIfPast(now: number, timezone: string, hour: number): string | null {
  const date = localDate(now, timezone);

  return now >= localTimeMs(date, hour, timezone) ? date : null;
}

function eligibleZones(db: DatabaseSync): string[] {
  return all<{ timezone: string }>(
    db,
    'SELECT DISTINCT timezone FROM users WHERE digest_enabled = 1 AND deactivated_at IS NULL',
  ).map((r) => r.timezone);
}

function claimDigestRuns(db: DatabaseSync, timezone: string, date: string, now: number): Id[] {
  return all<{ user_id: Id }>(
    db,
    `INSERT OR IGNORE INTO digest_runs (user_id, local_date, created_at)
     SELECT id, ?, ? FROM users WHERE timezone = ? AND digest_enabled = 1 AND deactivated_at IS NULL
     RETURNING user_id`,
    date,
    now,
    timezone,
  ).map((r) => r.user_id);
}

function scheduleZone(db: DatabaseSync, timezone: string, now: number): number {
  const date = localDateIfPast(now, timezone, DIGEST_HOUR);
  if (date === null) return 0;
  const userIds = claimDigestRuns(db, timezone, date, now);
  for (const userId of userIds) {
    const payload: DigestJobPayload = { user_id: userId, date, timezone };
    enqueue(db, { type: 'digest', payload, runAt: now, now });
  }

  return userIds.length;
}

export const digestRule: SchedulerRule = {
  counter: 'digests_created',
  run: (db, now) => eligibleZones(db).reduce((sum, timezone) => sum + scheduleZone(db, timezone, now), 0),
};
