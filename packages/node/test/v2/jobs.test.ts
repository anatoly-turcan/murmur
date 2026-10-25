import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRuntime, type Runtime, type Sqlite } from '@murmur/node';
import type { Jobs } from '@murmur/node/capabilities';
import type { Envelope } from 'murmur';

import { jobs as jobsToken } from '../../src/capabilities/jobs.ts';
import { openDatabase } from '../../src/capabilities/sqlite.ts';
import {
  Again,
  EnqueueInTx,
  Fatal,
  Flaky,
  Note,
  Record as RecordJob,
  Slow,
} from '../fixtures/v2/jobs/contracts/jobs.ts';
import { eventually, fixture } from '../helpers.ts';

const root = fixture('v2/jobs');
const T0 = '2026-10-25T12:00:30Z';
const MINUTE = 60_000;

interface Booted extends AsyncDisposable {
  readonly runtime: Runtime;
  readonly jobs: Jobs;
  readonly db: Sqlite;
  readonly tapped: Envelope[];
}

async function scratchFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'murmur-jobs-')), 'app.db');
}

async function boot(
  options: { process?: string; file?: string; env?: Record<string, string> } = {},
): Promise<Booted> {
  const tapped: Envelope[] = [];

  const runtime = await createRuntime({
    root,
    process: options.process ?? 'main',
    signals: false,
    tap: (envelope) => tapped.push(envelope),
    env: {
      MURMUR_LOG_LEVEL: 'error',
      MURMUR__CAP_CLOCK__OVERRIDABLE: 'true',
      DATABASE_PATH: options.file ?? (await scratchFile()),
      ...options.env,
    },
  });

  await runtime.start();
  await runtime.clock.freeze(T0);

  return {
    runtime,
    jobs: runtime.capabilities.get('jobs') as Jobs,
    db: runtime.capabilities.get('sqlite') as Sqlite,
    tapped,
    [Symbol.asyncDispose]: () => runtime.stop('test'),
  };
}

async function labels(db: Sqlite): Promise<string[]> {
  const rows = await db.all<{ label: string }>('SELECT label FROM runs ORDER BY rowid');

  return rows.map((row) => row.label);
}

async function jobRow(db: Sqlite, contract: string) {
  return db.get<{ state: string; attempt: number; run_at: number; error: string | null }>(
    'SELECT state, attempt, run_at, error FROM murmur_jobs WHERE contract = ?',
    contract,
  );
}

function sysNames(tapped: readonly Envelope[]): string[] {
  return tapped.filter((e) => e.name.startsWith('$sys.job.')).map((e) => e.name.slice('$sys.'.length));
}

test('an enqueue inside a rolled-back transaction leaves no row; a committed one runs', async () => {
  await using app = await boot();
  await assert.rejects(app.runtime.bus.request(EnqueueInTx, { label: 'undone', rollback: true }));
  assert.deepEqual(await app.jobs.counts(), { pending: 0, running: 0, dead: 0 });
  assert.deepEqual(await app.db.all('SELECT label FROM marks'), []);
  await app.runtime.bus.request(EnqueueInTx, { label: 'kept', rollback: false });
  assert.deepEqual(await app.jobs.counts(), { pending: 1, running: 0, dead: 0 });
  assert.deepEqual(await app.jobs.drain(), { ran: 1, failed: 0, dead: 0 });
  assert.deepEqual(await labels(app.db), ['kept']);
});

test('a thrown handler reschedules by the ladder, then goes dead at attempts', async () => {
  await using app = await boot();
  const t0 = Temporal.Instant.from(T0).epochMilliseconds;
  await app.jobs.enqueue(Flaky, { label: 'f' });
  assert.deepEqual(await app.jobs.drain(), { ran: 0, failed: 1, dead: 0 });

  assert.deepEqual(await jobRow(app.db, 'jobs.Flaky'), {
    state: 'pending',
    attempt: 1,
    run_at: t0 + MINUTE,
    error: 'Error: flaky f',
  });

  assert.deepEqual(await app.jobs.drain(), { ran: 0, failed: 0, dead: 0 });
  await app.runtime.clock.advance(MINUTE);
  assert.deepEqual(await app.jobs.drain(), { ran: 0, failed: 1, dead: 0 });
  assert.equal((await jobRow(app.db, 'jobs.Flaky'))?.run_at, t0 + 6 * MINUTE);
  await app.runtime.clock.advance(5 * MINUTE);
  assert.deepEqual(await app.jobs.drain(), { ran: 0, failed: 0, dead: 1 });
  assert.deepEqual(await app.jobs.counts(), { pending: 0, running: 0, dead: 1 });
  assert.equal((await jobRow(app.db, 'jobs.Flaky'))?.state, 'dead');
  assert.deepEqual(await labels(app.db), ['f', 'f', 'f']);
  assert.deepEqual(sysNames(app.tapped), [
    'job.claimed',
    'job.failed',
    'job.claimed',
    'job.failed',
    'job.claimed',
    'job.dead',
  ]);
});

test('NonRetryableError is dead at once; attempt and envelope id reach the handler', async () => {
  await using app = await boot();
  await app.jobs.enqueue(Fatal, { label: 'x' });
  assert.deepEqual(await app.jobs.drain(), { ran: 0, failed: 0, dead: 1 });

  assert.deepEqual(await jobRow(app.db, 'jobs.Fatal'), {
    state: 'dead',
    attempt: 1,
    run_at: Temporal.Instant.from(T0).epochMilliseconds,
    error: 'NonRetryableError: fatal x',
  });

  const id = await app.db.get<{ id: string }>("SELECT id FROM murmur_jobs WHERE contract = 'jobs.Fatal'");

  assert.deepEqual(await app.db.all('SELECT attempt, envelope FROM runs'), [
    { attempt: 1, envelope: id?.id },
  ]);
});

test('two jobs with one groupKey never run concurrently and run in enqueue order', async () => {
  await using app = await boot({ env: { MURMUR__CAP_JOBS__POLL: 'true', MURMUR__CAP_JOBS__POLL_MS: '10' } });
  await app.jobs.enqueue(Slow, { label: 'a', ms: 60 }, { groupKey: 'g' });
  await app.jobs.enqueue(Slow, { label: 'b', ms: 10 }, { groupKey: 'g' });
  await app.jobs.enqueue(Slow, { label: 'c', ms: 10 }, { groupKey: 'g' });
  await eventually(async () => (await labels(app.db)).length === 3);

  const rows = await app.db.all<{ label: string; started: number; ended: number }>(
    'SELECT label, started, ended FROM runs ORDER BY started',
  );

  assert.deepEqual(
    rows.map((row) => row.label),
    ['a', 'b', 'c'],
  );
  assert.ok(rows[1] !== undefined && rows[0] !== undefined && rows[1].started >= rows[0].ended);
  assert.ok(rows[2] !== undefined && rows[1] !== undefined && rows[2].started >= rows[1].ended);
});

test('a running job can re-enqueue its own dedupeKey; a pending twin is ignored', async () => {
  await using app = await boot();

  assert.deepEqual(await app.jobs.enqueue(Again, { key: 'k', times: 2 }, { dedupeKey: 'k' }), {
    enqueued: true,
  });

  assert.deepEqual(await app.jobs.enqueue(Again, { key: 'k', times: 9 }, { dedupeKey: 'k' }), {
    enqueued: false,
  });

  assert.deepEqual(await app.jobs.drain(), { ran: 3, failed: 0, dead: 0 });
  assert.deepEqual(await labels(app.db), ['k:2', 'k:1', 'k:0']);
});

test('a stale running row is reclaimed after the piece timeout, not before', async () => {
  await using app = await boot();
  const now = Temporal.Instant.from(T0).epochMilliseconds;
  const timeoutMs = app.runtime.bus.policyOf('worker').timeoutMs;

  await app.db.run(
    `INSERT INTO murmur_jobs (id, contract, input, state, attempt, run_at, locked_until, claim, created_at)
     VALUES ('crashed', 'jobs.Record', '{"label":"again"}', 'running', 1, ?, ?, 'gone', ?)`,
    now,
    now + timeoutMs,
    now,
  );

  assert.deepEqual(await app.jobs.drain(), { ran: 0, failed: 0, dead: 0 });
  await app.runtime.clock.advance(timeoutMs);
  assert.deepEqual(await app.jobs.drain(), { ran: 1, failed: 0, dead: 0 });
  assert.deepEqual(await app.db.all('SELECT label, attempt FROM runs'), [{ label: 'again', attempt: 2 }]);
});

test('a process without the handler never claims the job', async () => {
  const file = await scratchFile();
  await using producer = await boot({ process: 'producer', file });
  await using worker = await boot({ process: 'worker', file });
  await producer.runtime.bus.request(EnqueueInTx, { label: 'elsewhere', rollback: false });
  assert.deepEqual(await producer.jobs.drain(), { ran: 0, failed: 0, dead: 0 });
  assert.deepEqual(await producer.jobs.counts(), { pending: 1, running: 0, dead: 0 });
  assert.deepEqual(await worker.jobs.drain(), { ran: 1, failed: 0, dead: 0 });
  assert.deepEqual(await labels(worker.db), ['elsewhere']);
});

test('a process whose piece handles the job without needing jobs still claims and runs it', async () => {
  const file = await scratchFile();
  const polling = { MURMUR__CAP_JOBS__POLL: 'true', MURMUR__CAP_JOBS__POLL_MS: '10' };
  await using producer = await boot({ process: 'producer', file });
  await using plain = await boot({ process: 'plain', file, env: polling });
  await producer.jobs.enqueue(Note, { label: 'handled' });
  await eventually(async () => (await plain.db.all('SELECT label FROM plain_runs')).length === 1);
  assert.deepEqual(await producer.jobs.counts(), { pending: 0, running: 0, dead: 0 });
});

test('a stale claim that has used every attempt goes dead instead of running again', async () => {
  await using app = await boot();
  const now = Temporal.Instant.from(T0).epochMilliseconds;

  await app.db.run(
    `INSERT INTO murmur_jobs (id, contract, input, state, attempt, run_at, locked_until, claim, created_at)
     VALUES ('poison', 'jobs.Flaky', '{"label":"poison"}', 'running', 3, ?, ?, 'gone', ?)`,
    now,
    now,
    now,
  );

  assert.deepEqual(await app.jobs.drain(), { ran: 0, failed: 0, dead: 1 });
  assert.deepEqual(await labels(app.db), []);

  assert.deepEqual(await jobRow(app.db, 'jobs.Flaky'), {
    state: 'dead',
    attempt: 3,
    run_at: now,
    error: 'claim expired after 3 attempts',
  });

  assert.deepEqual(sysNames(app.tapped), ['job.dead']);
});

test('every fires once per window across two runtimes on one file', async () => {
  const file = await scratchFile();
  await using a = await boot({ process: 'ticker', file });
  await using b = await boot({ process: 'ticker', file });
  assert.deepEqual(await a.jobs.drain(), { ran: 1, failed: 0, dead: 0 });
  assert.deepEqual(await b.jobs.drain(), { ran: 0, failed: 0, dead: 0 });
  assert.deepEqual(await a.jobs.drain(), { ran: 0, failed: 0, dead: 0 });
  await a.runtime.clock.advance(MINUTE);
  assert.deepEqual(await b.jobs.drain(), { ran: 1, failed: 0, dead: 0 });
  assert.deepEqual(await a.jobs.drain(), { ran: 0, failed: 0, dead: 0 });

  assert.deepEqual(await a.db.all('SELECT at FROM ticks ORDER BY at'), [
    { at: T0 },
    { at: Temporal.Instant.from(T0).add({ minutes: 1 }).toString() },
  ]);

  assert.deepEqual(await a.db.all('SELECT name FROM murmur_schedules'), [{ name: 'jobs.Tick' }]);
});

test('stop waits for an in-flight job past the 2 s capability budget, up to the piece timeout', async () => {
  const file = await scratchFile();
  const app = await boot({ file, env: { MURMUR__CAP_JOBS__POLL: 'true', MURMUR__CAP_JOBS__POLL_MS: '10' } });
  await app.jobs.enqueue(Slow, { label: 'finish me', ms: 2300 });
  await eventually(async () => (await app.jobs.counts()).running === 1);
  await app.runtime.stop('test');
  const reopened = openDatabase(file).handle();

  assert.deepEqual(await reopened.all('SELECT label FROM runs'), [{ label: 'finish me' }]);
  assert.deepEqual(await reopened.all('SELECT id FROM murmur_jobs'), []);
});

test('stop releases a claim still running when its budget ends: back to pending, attempt refunded', async () => {
  await using app = await boot({ env: { MURMUR__CAP_JOBS__POLL: 'true', MURMUR__CAP_JOBS__POLL_MS: '10' } });
  await app.jobs.enqueue(Slow, { label: 'too slow', ms: 400 });
  await eventually(async () => (await app.jobs.counts()).running === 1);
  const stop = jobsToken.stop;
  assert.ok(stop !== undefined);
  await stop(app.jobs, AbortSignal.timeout(20));

  assert.deepEqual(await jobRow(app.db, 'jobs.Slow'), {
    state: 'pending',
    attempt: 0,
    run_at: Temporal.Instant.from(T0).epochMilliseconds,
    error: null,
  });
});

test('drain() runs due jobs and schedules under a frozen clock and returns counts', async () => {
  await using app = await boot({ process: 'timed' });
  await app.jobs.enqueue(RecordJob, { label: 'now' });

  await app.jobs.enqueue(
    RecordJob,
    { label: 'later' },
    { runAt: Temporal.Instant.from(T0).add({ minutes: 2 }) },
  );

  assert.deepEqual(await app.jobs.drain(), { ran: 2, failed: 0, dead: 0 });
  assert.deepEqual(await labels(app.db), ['now']);
  assert.deepEqual(await app.jobs.counts(), { pending: 1, running: 0, dead: 0 });
  await app.runtime.clock.advance(2 * MINUTE);
  assert.deepEqual(await app.jobs.drain(), { ran: 2, failed: 0, dead: 0 });
  assert.deepEqual(await labels(app.db), ['now', 'later']);
  assert.equal((await app.db.all('SELECT at FROM ticks')).length, 2);
  assert.deepEqual(await app.jobs.counts(), { pending: 0, running: 0, dead: 0 });
});

test('a job delivery is an ingress entry of transport job: run context and $sys.ingress events', async () => {
  await using app = await boot();
  await app.jobs.enqueue(RecordJob, { label: 'traced' });
  await app.jobs.drain();
  const received = app.tapped.find((e) => e.name === '$sys.ingress.received');
  const entry = (received?.payload as { envelope: Envelope } | undefined)?.envelope;

  assert.equal(entry?.name, '$ingress.job');
  assert.deepEqual(entry?.payload, { label: 'traced', binding: 'jobs.Record' });
  assert.ok(app.tapped.some((e) => e.name === '$sys.ingress.completed'));
});

test('enqueue refuses a contract that is not a Command and an input that fails its schema', async () => {
  await using app = await boot();

  await assert.rejects(app.jobs.enqueue(RecordJob, { label: 1 } as never), {
    name: 'ContractViolationError',
  });

  await assert.rejects(app.jobs.enqueue({ name: 'Nope' } as never, {} as never), {
    message:
      'jobs.enqueue(Nope): Nope is not a Command; a job is a Command, e.g. class Notify extends Command({ id: z.string() }, {})',
  });
});
