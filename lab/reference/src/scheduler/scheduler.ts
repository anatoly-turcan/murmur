import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { one } from '../db/sql.ts';
import { immediate } from '../db/tx.ts';
import { enqueue } from '../jobs/queue.ts';
import { errorFields, type Logger } from '../log.ts';
import type { SchedulerCounter, SchedulerRule } from '../slices/types.ts';
import { appNow } from '../time/clock.ts';

export type SchedulerCounts = Record<SchedulerCounter, number>;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export function runSchedulerEvaluation(db: DatabaseSync, now: number, rules: readonly SchedulerRule[], manual = false): SchedulerCounts {
  return immediate(db, () => {
    const counts: SchedulerCounts = { digests_created: 0, reminders_created: 0 };
    for (const rule of rules) {
      const created = rule.run(db, now, manual);
      if (rule.counter) counts[rule.counter] += created;
    }

    return counts;
  });
}

export function enqueueMaintenanceIfIdle(db: DatabaseSync, now: number): void {
  immediate(db, () => {
    const recent = one(
      db,
      `SELECT 1 AS x FROM jobs WHERE type = 'maintenance' AND (status IN ('pending', 'running') OR created_at > ?) LIMIT 1`,
      now - HOUR_MS,
    );
    if (!recent) enqueue(db, { type: 'maintenance', runAt: now, now });
  });
}

export interface SchedulerDriver {
  stop(): void;
}

export function startSchedulerDriver(db: DatabaseSync, config: Config, log: Logger, rules: readonly SchedulerRule[]): SchedulerDriver {
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    try {
      const now = appNow(db, config.testMode);
      const counts = runSchedulerEvaluation(db, now, rules);
      enqueueMaintenanceIfIdle(db, now);
      log.info('scheduler tick', counts);
    } catch (err) {
      log.error('scheduler tick failed', errorFields(err));
    }
    schedule();
  };
  const schedule = () => {
    timer = setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS) + 50);
  };
  schedule();

  return { stop: () => clearTimeout(timer) };
}
