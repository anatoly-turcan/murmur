import { isSettledLifecycleRun, MurmurError, systemClock, type Clock, type RunContext } from 'murmur';
import { z } from 'zod';

import { current } from '../context.ts';
import { ambientHolder } from './holder.ts';
import type { Database } from './sqlite.ts';

export const clockConfig = z.object({ overridable: z.boolean().default(false) });

export type ClockSettings = z.output<typeof clockConfig>;

export const OVERRIDABLE_IN_PROD =
  'capabilities.clock.overridable is true in prod mode: a frozen instant in murmur_clock would apply to every request; set it only in test environments (drop the key or MURMUR__CAP_CLOCK__OVERRIDABLE=false)';

export interface OverridableClock extends Clock {
  attach(database: Database): Promise<void>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS murmur_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  frozen TEXT NOT NULL
)`;

const SELECT = 'SELECT frozen FROM murmur_clock WHERE id = 1';

const UPSERT = `INSERT INTO murmur_clock (id, frozen) VALUES (1, ?)
  ON CONFLICT (id) DO UPDATE SET frozen = excluded.frozen`;

const DELETE = 'DELETE FROM murmur_clock';

function notStarted(): MurmurError {
  return new MurmurError(
    'clock override used before the runtime started; call `await runtime.start()` first, or call it from a handler or onStart',
    {
      code: 'clock-not-started',
      retryable: false,
    },
  );
}

function liveRun(): RunContext | undefined {
  const run = current();

  return run === undefined || isSettledLifecycleRun(run) ? undefined : run;
}

export function overridableClock(): OverridableClock {
  let database: Database | undefined;
  const seen = new WeakMap<object, Temporal.Instant | null>();
  const stored = (): Temporal.Instant | null => {
    const row = database?.peek<{ frozen: string }>(SELECT);

    return row === undefined ? null : Temporal.Instant.from(row.frozen);
  };
  const frozen = (): Temporal.Instant | null => {
    const run = liveRun();
    if (run === undefined) {
      return stored();
    }

    if (!seen.has(run)) {
      seen.set(run, stored());
    }

    return seen.get(run) ?? null;
  };
  const now = () => frozen() ?? Temporal.Now.instant();
  const write = async (value: Temporal.Instant | null): Promise<void> => {
    if (database === undefined) {
      throw notStarted();
    }

    const sql = database.handleFor(ambientHolder);
    if (value === null) {
      await sql.run(DELETE);
    } else {
      await sql.run(UPSERT, value.toString());
    }

    const run = liveRun();
    if (run !== undefined) {
      seen.set(run, value);
    }
  };

  return {
    now,
    zonedNow: (tz?: string) => now().toZonedDateTimeISO(tz ?? Temporal.Now.timeZoneId()),
    sleep: systemClock.sleep,
    freeze: (instant) => write(Temporal.Instant.from(instant)),
    advance: (ms) => write(now().add({ milliseconds: ms })),
    clear: () => write(null),
    attach: async (next) => {
      await next.handle().exec(SCHEMA);
      database = next;
    },
  };
}
