import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { MurmurError, parseWire, systemClock, type Clock, type CommandClass, type Schema } from 'murmur';

import { ambientHolder } from '../capabilities/holder.ts';
import { countJobs, insertJob, JOBS_SCHEMA } from '../capabilities/jobs-store.ts';
import { assertCommand } from '../capabilities/jobs.ts';
import { windowEnd } from '../capabilities/kv.ts';
import { ambientSqlite, asDatabase, openDatabase, type Database } from '../capabilities/sqlite.ts';
import type { EnqueueOptions, Fetch, Jobs, Kv, OnceResult, Sqlite } from '../capabilities/types.ts';
import { sqliteSettings } from '../migrate.ts';
import { appRootOf, callerFile } from './app-root.ts';

interface Stored {
  readonly value: unknown;
  readonly expiresAt: number | undefined;
}

export type FakeSchema = 'app' | 'own' | readonly string[];

export interface FakeSqliteOptions {
  readonly schema?: FakeSchema | undefined;
  readonly root?: string | undefined;
  readonly pieceDir?: string | undefined;
}

interface SchemaPlace {
  readonly root: string;
  readonly dir: string;
}

function callerDir(): string {
  const caller = callerFile();

  return caller === undefined ? process.cwd() : dirname(caller);
}

function placeOf(options: FakeSqliteOptions): SchemaPlace {
  const dir = options.pieceDir ?? callerDir();

  return { root: options.root ?? appRootOf(dir), dir };
}

async function sourcesOf(schema: FakeSchema, place: SchemaPlace): Promise<string | readonly string[]> {
  if (schema === 'app') {
    return (await sqliteSettings(place.root, process.env)).migrations;
  }

  if (schema === 'own') {
    const own = join(place.dir, 'schema.sql');

    return existsSync(own) ? [relative(place.root, own)] : [];
  }

  return schema;
}

export async function fakeSqlite(options: FakeSqliteOptions = {}): Promise<Sqlite> {
  const database = openDatabase(':memory:');
  if (options.schema !== undefined) {
    const place = placeOf(options);
    await database.migrate(await sourcesOf(options.schema, place), place.root);
  }

  return ambientSqlite(database);
}

export const ADOPT_CLOCK = Symbol('murmur.testing.adoptClock');

export function adoptClock(need: unknown, clock: Clock): void {
  const adopt: unknown =
    typeof need === 'object' && need !== null ? Reflect.get(need, ADOPT_CLOCK) : undefined;

  if (typeof adopt === 'function') {
    adopt(clock);
  }
}

export function fakeKv(clock: Clock = systemClock): Kv {
  let time = clock;
  let values = new Map<string, Stored>();
  const markers = new Map<string, Stored>();
  const counters = new Map<string, { count: number; resetMs: number }>();
  const nowMs = () => time.now().epochMilliseconds;
  const live = (entry: Stored | undefined): entry is Stored =>
    entry !== undefined && (entry.expiresAt === undefined || entry.expiresAt > nowMs());
  const expiry = (ttlMs: number | undefined) => (ttlMs === undefined ? undefined : nowMs() + ttlMs);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});

    return next;
  };

  const kv: Kv = {
    get: async <T>(key: string) => {
      const entry = values.get(key);

      return live(entry) ? (structuredClone(entry.value) as T) : undefined;
    },
    set: async (key, value, options) => {
      values.set(key, { value: structuredClone(value), expiresAt: expiry(options?.ttlMs) });
    },
    delete: async (key) => {
      values.delete(key);
    },
    once: <T>(id: string, effect: () => T | Promise<T>, options?: { ttlMs?: number }) =>
      serial(async (): Promise<OnceResult<T>> => {
        if (live(markers.get(id))) {
          return { first: false };
        }

        const snapshot = new Map(values);

        try {
          const value = await effect();
          markers.set(id, { value: null, expiresAt: expiry(options?.ttlMs) });

          return { first: true, value };
        } catch (error) {
          values = snapshot;
          throw error;
        }
      }),
    incr: async (key, { windowMs }) => {
      const resetMs = windowEnd(nowMs(), windowMs);
      const previous = counters.get(key);
      const count = previous?.resetMs === resetMs ? previous.count + 1 : 1;
      counters.set(key, { count, resetMs });

      return { count, resetAt: Temporal.Instant.fromEpochMilliseconds(resetMs) };
    },
  };

  return Object.assign(kv, {
    [ADOPT_CLOCK]: (next: Clock) => {
      time = next;
    },
  });
}

export function fakeFetch(handler: (request: Request) => Response | Promise<Response>): Fetch {
  return async (input, init) => handler(new Request(input, init));
}

export function unstubbedFetch(): Fetch {
  return async (input) => {
    throw new MurmurError(
      `fetch ${String(input)}: testPiece faked fetch without a handler; pass needs: { fetch: fakeFetch((request) => Response.json({})) }`,
      { code: 'fetch-not-stubbed', retryable: false },
    );
  };
}

export interface RecordedJob {
  readonly id: string;
  readonly contract: CommandClass;
  readonly input: unknown;
  readonly options: EnqueueOptions;
}

export interface JobRecords {
  readonly database: Database;
  readonly jobs: Map<string, RecordedJob>;
}

const JOB_RECORDS = Symbol('murmur.testing.jobRecords');

export function jobRecordsOf(need: unknown): JobRecords | undefined {
  const records: unknown =
    typeof need === 'object' && need !== null ? Reflect.get(need, JOB_RECORDS) : undefined;

  return records as JobRecords | undefined;
}

function stateOf(records: JobRecords, job: RecordedJob): string | undefined {
  return records.database.peek<{ state: string }>('SELECT state FROM murmur_jobs WHERE id = ?', job.id)
    ?.state;
}

export function recordedJobs(records: JobRecords): RecordedJob[] {
  return [...records.jobs.values()].filter((job) => stateOf(records, job) !== undefined);
}

export function pendingJobs(records: JobRecords): RecordedJob[] {
  return [...records.jobs.values()].filter((job) => stateOf(records, job) === 'pending');
}

export async function markRan(records: JobRecords, job: RecordedJob): Promise<void> {
  await records.database.handle().run("UPDATE murmur_jobs SET state = 'ran' WHERE id = ?", job.id);
}

export async function clearJobs(records: JobRecords): Promise<void> {
  records.jobs.clear();
  await records.database.handle().run('DELETE FROM murmur_jobs');
}

function jobsDatabase(sqlite: unknown): Database {
  try {
    return asDatabase(sqlite);
  } catch {
    throw new MurmurError(
      'the jobs fake keeps its rows on the sqlite need of the same piece; pass needs: { db: await fakeSqlite() } or a jobs handle of your own',
      { code: 'jobs-fake-sqlite', retryable: false },
    );
  }
}

export async function fakeJobs(sqlite: unknown, clock: Clock): Promise<Jobs> {
  const database = jobsDatabase(sqlite);
  await database.handle().exec(JOBS_SCHEMA);
  const ambient = database.handleFor(ambientHolder);
  const records: JobRecords = { database, jobs: new Map() };

  const jobs: Jobs = {
    enqueue: async (contract, input, options = {}) => {
      assertCommand(contract);
      const value = await parseWire(contract.wireName, 'payload', contract.input as Schema, input);
      const id = crypto.randomUUID();
      const now = clock.now().epochMilliseconds;

      const enqueued = await insertJob(ambient, {
        id,
        contract: contract.wireName,
        input: JSON.stringify(value),
        runAt: options.runAt?.epochMilliseconds ?? now,
        dedupeKey: options.dedupeKey ?? null,
        groupKey: options.groupKey ?? null,
        now,
      });

      if (enqueued) {
        records.jobs.set(id, { id, contract, input: value, options });
      }

      return { enqueued };
    },
    drain: async () => {
      throw new MurmurError(
        'the jobs fake records enqueues; run them with await t.runJobs() (testPiece) or await app.jobs.drain() (createTestApp)',
        { code: 'jobs-fake-drain', retryable: false },
      );
    },
    counts: () => countJobs(database.handle()),
  };

  return Object.assign(jobs, { [JOB_RECORDS]: records });
}
