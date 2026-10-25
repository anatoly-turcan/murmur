import type { Clock, Ids, Log, LogRecord } from '../model/capabilities.ts';
import type { RunContext } from '../model/context.ts';
import type { ContextStorage } from '../runtime/context.ts';

export interface FakeLog extends Log {
  readonly records: LogRecord[];
}

export interface FakeIds extends Ids {
  readonly issued: string[];
}

type Fields = Record<string, unknown>;

function mergeFields(bound: Fields, data: Fields | undefined): Fields | undefined {
  if (data === undefined && Object.keys(bound).length === 0) {
    return undefined;
  }

  return { ...bound, ...data };
}

function recorder(records: LogRecord[], bound: Fields): Log {
  const write = (level: LogRecord['level']) => (message: string, data?: Fields) => {
    records.push({ level, message, data: mergeFields(bound, data) });
  };

  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (data) => recorder(records, { ...bound, ...data }),
  };
}

export function fakeLog(): FakeLog {
  const records: LogRecord[] = [];

  return { ...recorder(records, {}), records };
}

export function fakeClock(start = '2026-01-01T00:00:00Z'): Clock {
  let frozen: Temporal.Instant | null = Temporal.Instant.from(start);
  const now = () => frozen ?? Temporal.Now.instant();
  const advance = async (ms: number) => {
    frozen = now().add({ milliseconds: ms });
  };

  return {
    now,
    zonedNow: (tz = 'UTC') => now().toZonedDateTimeISO(tz),
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      await advance(ms);
    },
    freeze: async (instant) => {
      frozen = Temporal.Instant.from(instant);
    },
    advance,
    clear: async () => {
      frozen = null;
    },
  };
}

export function fakeIds(): FakeIds {
  const issued: string[] = [];
  const issue = (format: (n: number) => string) => () => {
    const id = format(issued.length + 1);
    issued.push(id);

    return id;
  };

  return {
    issued,
    uuid: issue((n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`),
    short: issue((n) => n.toString(36).padStart(8, '0')),
  };
}

export function fakeContextStorage<T = RunContext>(): ContextStorage<T> {
  let store: T | undefined;

  return {
    run: (next, fn) => {
      const previous = store;
      store = next;

      try {
        return fn();
      } finally {
        store = previous;
      }
    },
    getStore: () => store,
  };
}
