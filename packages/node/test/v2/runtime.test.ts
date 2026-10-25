import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { BootFailedError, createRuntime, RemoteError, type BootReport, type Sqlite } from '@murmur/node';
import type { Envelope } from 'murmur';

import { AuditReport } from '../fixtures/v2/app/contracts/audit.ts';
import {
  ArchiveTodo,
  CountWrites,
  CreateTodo,
  GetTodo,
  ProbeNesting,
  WriteRequested,
} from '../fixtures/v2/app/contracts/todos.ts';
import { CountInvoices } from '../fixtures/v2/app/pieces/billing/contracts.ts';
import { eventually, fixture, named, payloadOf, until } from '../helpers.ts';

const root = fixture('v2/app');
const env = { MURMUR_LOG_LEVEL: 'info' };

function boot(tapped: Envelope[] = [], extraEnv: Record<string, string> = {}) {
  return createRuntime({ root, env: { ...env, ...extraEnv }, signals: false, tap: (e) => tapped.push(e) });
}

async function bootReportOf(promise: Promise<unknown>): Promise<BootReport> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  assert.ok(error instanceof BootFailedError, `expected BootFailedError, got ${String(error)}`);

  return error.report;
}

test('the fixture app (3 class pieces, one nested, one internal contract) boots and answers a Query end to end', async () => {
  await using runtime = await boot();
  const internal = runtime.report.catalog.contracts.find((c) => c.name === CountInvoices.wireName);

  assert.equal(runtime.report.ok, true, JSON.stringify(runtime.report.errors));
  assert.deepEqual(
    runtime.pieces.map((p) => p.name),
    ['audit', 'billing/invoice', 'todos'],
  );
  assert.deepEqual([internal?.visibility, internal?.scope], ['internal', 'billing']);
  await runtime.start();
  const created = await runtime.bus.request(CreateTodo, { title: 'milk' });
  assert.deepEqual(await runtime.bus.request(GetTodo, { id: created.id }), created);
  assert.equal(await runtime.bus.request(GetTodo, { id: 'nope' }), null);
  await eventually(async () => (await runtime.bus.request(CountInvoices, {})).drafted === 1);
});

async function appliedMigrations(
  extraEnv: Record<string, string> = {},
): Promise<{ names: string[]; tables: string[] }> {
  await using runtime = await boot([], extraEnv);
  await runtime.start();
  const db = runtime.capabilities.get('sqlite') as Sqlite;
  const names = await db.all<{ name: string }>('SELECT name FROM murmur_migrations');

  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'todos'",
  );

  return { names: names.map((row) => row.name), tables: tables.map((row) => row.name) };
}

async function inDirectory<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(directory);

  try {
    return await work();
  } finally {
    process.chdir(previous);
  }
}

test('sqlite.migrations globs apply every piece schema.sql once, recorded relative to the app root', async () => {
  assert.deepEqual(await appliedMigrations(), { names: ['pieces/todos/schema.sql'], tables: ['todos'] });
});

test('sqlite.migrations globs and a relative sqlite.path resolve against the app root whatever the cwd', async () => {
  const scratch = join(root, '.murmur');
  const database = join(scratch, 'chdir.db');
  await mkdir(scratch, { recursive: true });

  try {
    const applied = await inDirectory(join(root, 'pieces'), () =>
      appliedMigrations({ MURMUR__CAP_SQLITE__PATH: '.murmur/chdir.db' }),
    );

    assert.deepEqual(applied, { names: ['pieces/todos/schema.sql'], tables: ['todos'] });
    assert.ok(existsSync(database), `expected ${database}`);
    assert.equal(existsSync(join(root, 'pieces', '.murmur')), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('onStart requesting a later piece contract succeeds, and config comes from murmur.yaml', async () => {
  await using runtime = await boot();
  await runtime.start();

  assert.deepEqual(await runtime.bus.request(AuditReport, {}), {
    label: 'fixture',
    todosAtStart: 0,
    seen: 0,
  });
});

test('this.db and a nested transaction(fn) join the delivery transaction; its rollback undoes both writes', async () => {
  await using runtime = await boot();
  await runtime.start();
  assert.deepEqual(await runtime.bus.request(ProbeNesting, {}), { joined: 2, kept: 0 });
});

test('concurrency 8 with an await inside every transaction commits every row (M4 on the ALS handle)', async () => {
  const tapped: Envelope[] = [];
  await using runtime = await boot(tapped);
  await runtime.start();
  const count = 40;
  const acked = () =>
    named(tapped, '$sys.delivery.acked').filter((e) => payloadOf(e)['name'] === WriteRequested.wireName);

  await Promise.all(Array.from({ length: count }, (_, n) => runtime.bus.emit(WriteRequested, { n })));
  await until(() => acked().length === count);

  assert.equal(named(tapped, '$sys.delivery.failed').length, 0);
  assert.deepEqual(await runtime.bus.request(CountWrites, {}), { rows: count * 2 });
  assert.equal(runtime.pieces.find((p) => p.name === 'todos')?.runtime.policy.concurrency, 8);
});

test('emit of an undeclared same-shape event throws at runtime with the piece and the wire name', async () => {
  const tapped: Envelope[] = [];
  await using runtime = await boot(tapped);
  await runtime.start();
  await assert.rejects(runtime.bus.request(ArchiveTodo, { id: '1' }), RemoteError);
  const dead = named(tapped, '$sys.delivery.deadlettered')[0];
  const error = payloadOf(dead)['error'] as { name: string; message: string };

  assert.equal(error.name, 'EmitNotDeclaredError');
  assert.match(error.message, /^piece todos emits todos\.TodoArchived but does not declare it/);
});

test('timers opened in onStart do not share a transaction after the hook returned', async () => {
  await using runtime = await createRuntime({ root: fixture('v2/poller'), env, signals: false });
  await runtime.start();
  const db = runtime.capabilities.get('sqlite') as Sqlite;
  await eventually(async () => (await db.all('SELECT tick FROM outcomes')).length === 3);

  assert.deepEqual(await db.all('SELECT tick, outcome FROM outcomes ORDER BY tick'), [
    { tick: 'committed', outcome: 'ok' },
    { tick: 'plain', outcome: 'ok' },
    { tick: 'rolled-back', outcome: 'Error: rolled back' },
  ]);

  assert.deepEqual(await db.all('SELECT v FROM ticks ORDER BY v'), [{ v: 'committed' }, { v: 'plain' }]);
});

test('a field initialiser that throws yields BootError { phase: construct } naming the piece and file', async () => {
  const runtime = await createRuntime({ root: fixture('v2/construct'), env, signals: false });
  const report = await bootReportOf(runtime.start());
  const [error] = report.errors;

  assert.equal(report.ok, false);
  assert.equal(error?.phase, 'construct');
  assert.equal(error?.piece, 'boom');
  assert.equal(error?.file, fixture('v2/construct/pieces/boom/piece.ts'));
  assert.match(error?.message ?? '', /Boom could not be constructed: Error: cannot reach the ledger/);
  assert.equal(report.pieces.find((p) => p.name === 'boom')?.errors.length, 1);
});

test('BootReport names a piece whose piece.ts exports two piece classes or none', async () => {
  const report = await bootReportOf(createRuntime({ root: fixture('v2/exports'), env, signals: false }));
  const messageOf = (name: string) => report.pieces.find((p) => p.name === name)?.errors[0]?.message ?? '';

  assert.match(messageOf('two'), /piece\.ts exports 2 piece classes \(First, Second\): export exactly one/);
  assert.match(messageOf('none'), /piece\.ts must export one piece class/);
});
