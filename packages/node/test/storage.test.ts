import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRuntime, defineApp, migrate } from '@murmur/node';
import { fakeKv, fakeSqlite } from '@murmur/node/testing';
import { createMemoryTransport } from '@murmur/transport-memory';
import { markLifecycleSettled } from 'murmur';
import { fakeClock } from 'murmur/testing';

import { overridableClock } from '../src/capabilities/clock.ts';
import { kv } from '../src/capabilities/kv.ts';
import { databasePath, openDatabase, sqlite, type Database } from '../src/capabilities/sqlite.ts';
import type { Kv } from '../src/capabilities/types.ts';
import { runContext } from '../src/context.ts';

function run(piece: string) {
  return {
    traceId: 'trace',
    hop: 0,
    piece,
    signal: new AbortController().signal,
    internal: false,
    deliveryId: piece,
  };
}

async function scratch(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'murmur-storage-'));
  const entries = Object.entries(files);
  await Promise.all(entries.map(([path]) => mkdir(join(dir, path, '..'), { recursive: true })));
  await Promise.all(entries.map(([path, text]) => writeFile(join(dir, path), text)));

  return dir;
}

async function kvOn(database: Database, clock = fakeClock()): Promise<Kv> {
  return kv().start({ config: { namespace: 'app' }, needs: { sqlite: database }, clock } as never);
}

test('outside a run, calls awaited inside the transaction callback join it instead of waiting on it', async () => {
  const db = await fakeSqlite();
  await db.exec('CREATE TABLE t (v TEXT)');

  await db.transaction(async () => {
    await db.run('INSERT INTO t VALUES (?)', 'direct');
    await db.transaction(async (inner) => inner.run('INSERT INTO t VALUES (?)', 'nested'));

    await db
      .transaction(async (inner) => {
        await inner.run('INSERT INTO t VALUES (?)', 'kept');
        throw new Error('inner');
      })
      .catch(() => undefined);
  });

  assert.deepEqual(await db.all('SELECT v FROM t ORDER BY v'), [
    { v: 'direct' },
    { v: 'kept' },
    { v: 'nested' },
  ]);
});

test('a nested transaction(fn) joins the outer one and the outer rollback undoes the inner write', async () => {
  const db = await fakeSqlite();
  await db.exec('CREATE TABLE t (v TEXT)');
  let seen: unknown[] = [];

  const outcome = await runContext.run(run('a'), () =>
    db
      .transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (?)', 'outer');
        await db.transaction(async (inner) => inner.run('INSERT INTO t VALUES (?)', 'inner'));
        seen = await db.all('SELECT v FROM t ORDER BY v');
        throw new Error('roll back');
      })
      .then(
        () => 'committed',
        (error: unknown) => String(error),
      ),
  );

  assert.deepEqual(seen, [{ v: 'inner' }, { v: 'outer' }]);
  assert.equal(outcome, 'Error: roll back');
  assert.deepEqual(await db.all('SELECT v FROM t'), []);
});

test('transaction(fn) commits on return and hands back the callback value', async () => {
  const db = await fakeSqlite();
  await db.exec('CREATE TABLE t (v TEXT)');

  const value = await db.transaction(async (tx) => {
    await tx.run('INSERT INTO t VALUES (?)', 'kept');

    return 42;
  });

  assert.equal(value, 42);
  assert.deepEqual(await db.all('SELECT v FROM t'), [{ v: 'kept' }]);
});

test('kv.once and db.* of the same delivery join one transaction: the outer rollback drops marker and effect', async () => {
  const database = openDatabase(':memory:');
  const store = await kvOn(database);
  const db = database.handleFor(() => runContext.getStore()?.deliveryId);
  await db.exec('CREATE TABLE effects (v TEXT)');

  const outcome = await runContext.run(run('b'), () =>
    db
      .transaction(async () => {
        await store.once('job-1', () => db.run('INSERT INTO effects VALUES (?)', 'sent'));
        throw new Error('roll back');
      })
      .then(
        () => 'committed',
        (error: unknown) => String(error),
      ),
  );

  const again = await runContext.run(run('c'), () =>
    store.once('job-1', async () => {
      await db.run('INSERT INTO effects VALUES (?)', 'retried');

      return 'ran';
    }),
  );

  assert.equal(outcome, 'Error: roll back');
  assert.deepEqual(again, { first: true, value: 'ran' });
  assert.deepEqual(await db.all('SELECT v FROM effects'), [{ v: 'retried' }]);
  database.close();
});

test('insert returns the given primary key, or the rowid as a number', async () => {
  const db = await fakeSqlite();

  await db.exec(
    'CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)',
  );

  await db.exec('CREATE TABLE notes (body TEXT NOT NULL)');
  assert.equal(await db.insert('todos', { id: 't1', title: 'buy milk' }), 't1');
  assert.equal(await db.insert('notes', { body: 'one' }), 1);
  assert.equal(await db.insert('notes', { body: 'two' }), 2);

  assert.deepEqual(await db.get('SELECT id, title, done FROM todos'), {
    id: 't1',
    title: 'buy milk',
    done: 0,
  });

  await assert.rejects(db.insert('todos; DROP TABLE todos', { id: 'x' }), {
    name: 'SqliteError',
    message:
      /db\.insert: table "todos; DROP TABLE todos" is not a plain identifier; use letters, digits and _/,
  });
});

test('kv.incr counts across two connections on one file and restarts at the window edge', async () => {
  const dir = await scratch();
  const file = join(dir, 'app.db');
  const clock = fakeClock('2026-01-01T00:00:59.000Z');
  const first = openDatabase(file);
  const second = openDatabase(file);

  try {
    const a = await kvOn(first, clock);
    const b = await kvOn(second, clock);
    const resetAt = Temporal.Instant.from('2026-01-01T00:01:00Z');

    assert.deepEqual(await a.incr('ip:1', { windowMs: 60_000 }), { count: 1, resetAt });
    assert.deepEqual(await b.incr('ip:1', { windowMs: 60_000 }), { count: 2, resetAt });
    assert.deepEqual(await a.incr('ip:2', { windowMs: 60_000 }), { count: 1, resetAt });
    await clock.advance(1_000);

    assert.deepEqual(await b.incr('ip:1', { windowMs: 60_000 }), {
      count: 1,
      resetAt: Temporal.Instant.from('2026-01-01T00:02:00Z'),
    });

    await assert.rejects(a.incr('ip:1', { windowMs: 0 }), /kv\.incr: windowMs must be a positive integer/);
  } finally {
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('fakeKv.incr follows the clock it is given', async () => {
  const clock = fakeClock('2026-01-01T00:00:00Z');
  const store = fakeKv(clock);

  assert.equal((await store.incr('k', { windowMs: 1_000 })).count, 1);
  assert.equal((await store.incr('k', { windowMs: 1_000 })).count, 2);
  await clock.advance(1_000);
  assert.equal((await store.incr('k', { windowMs: 1_000 })).count, 1);
});

test('a frozen overridable clock is seen by a second connection, read once per run context', async () => {
  const dir = await scratch();
  const file = join(dir, 'app.db');
  const first = openDatabase(file);
  const second = openDatabase(file);
  const writer = overridableClock();
  const reader = overridableClock();

  try {
    await writer.attach(first);
    await reader.attach(second);
    await writer.freeze('2030-05-01T12:00:00Z');
    assert.equal(reader.now().toString(), '2030-05-01T12:00:00Z');

    const held = await runContext.run(run('d'), async () => {
      const before = reader.now().toString();
      await writer.advance(60_000);

      return [before, reader.now().toString()];
    });

    assert.deepEqual(held, ['2030-05-01T12:00:00Z', '2030-05-01T12:00:00Z']);
    assert.equal(reader.now().toString(), '2030-05-01T12:01:00Z');
    await writer.clear();
    assert.ok(Math.abs(reader.now().epochMilliseconds - Date.now()) < 5_000);
  } finally {
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a timer inside a settled onStart run sees an advance written from outside', async () => {
  const dir = await scratch();
  const database = openDatabase(join(dir, 'app.db'));
  const clock = overridableClock();
  const lifecycle = run('poller');
  const tick = () => runContext.run(lifecycle, () => clock.now().toString());

  try {
    await clock.attach(database);
    await clock.freeze('2030-01-01T00:00:00Z');
    markLifecycleSettled(lifecycle);
    const first = tick();
    await clock.advance(3_600_000);

    assert.deepEqual([first, tick()], ['2030-01-01T00:00:00Z', '2030-01-01T01:00:00Z']);
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a clock override before the runtime started names runtime.start()', async () => {
  await assert.rejects(overridableClock().freeze('2030-01-01T00:00:00Z'), {
    code: 'clock-not-started',
    message: /call `await runtime\.start\(\)` first, or call it from a handler or onStart/,
  });
});

test('freeze on a clock that is not overridable throws and names the yaml switch', async () => {
  const runtime = await createRuntime({
    root: await scratch({ 'pieces/.keep': '' }),
    app: defineApp({ name: 'plain', transport: createMemoryTransport() }),
    env: { MURMUR_LOG_LEVEL: 'error' },
    signals: false,
  });

  await assert.rejects(runtime.clock.freeze('2030-01-01T00:00:00Z'), {
    code: 'clock-not-overridable',
    message: /clock\.freeze needs capabilities\.clock\.overridable: true in murmur\.yaml/,
  });

  await runtime.stop();
});

test('capabilities.clock.overridable warns in prod mode, not in dev, and freezes through murmur_clock', async () => {
  const root = await scratch({
    'pieces/.keep': '',
    'murmur.yaml': 'capabilities:\n  clock:\n    overridable: true\n',
  });

  const boot = (mode: 'dev' | 'prod') =>
    createRuntime({
      root,
      app: defineApp({ name: 'clocked', transport: createMemoryTransport() }),
      env: { MURMUR_LOG_LEVEL: 'error', MURMUR__CAP_SQLITE__PATH: join(root, 'app.db') },
      signals: false,
      mode,
    });

  try {
    const prod = await boot('prod');
    const dev = await boot('dev');
    const warning = prod.report.warnings.find((w) => w.code === 'clock-overridable-prod');

    assert.match(
      warning?.message ?? '',
      /capabilities\.clock\.overridable is true in prod mode: .*set it only in test environments/,
    );
    assert.equal(
      dev.report.warnings.some((w) => w.code === 'clock-overridable-prod'),
      false,
    );

    await dev.start();
    await dev.clock.freeze('2031-01-01T00:00:00Z');
    assert.equal(dev.clock.now().toString(), '2031-01-01T00:00:00Z');
    await dev.stop();
    await prod.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migrate(root) applies the default list (pieces/**/schema.sql, then migrations/*.sql) once and reports it', async () => {
  const root = await scratch({
    'pieces/todos/schema.sql': 'CREATE TABLE todos (id TEXT PRIMARY KEY);',
    'migrations/001-seed.sql': "INSERT INTO todos VALUES ('seed');",
    'murmur.yaml': 'capabilities:\n  sqlite:\n    path: sqlite:./data/app.db\n',
  });

  try {
    await mkdir(join(root, 'data'));
    const first = await migrate(root, {});
    const second = await migrate(root, {});
    const database = openDatabase(join(root, 'data', 'app.db'));
    const rows = await database.handle().all('SELECT id FROM todos');
    database.close();

    assert.deepEqual(first, {
      path: join(root, 'data', 'app.db'),
      files: ['pieces/todos/schema.sql', 'migrations/001-seed.sql'],
      applied: ['pieces/todos/schema.sql', 'migrations/001-seed.sql'],
      unmatched: [],
    });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(rows, [{ id: 'seed' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migrate(root) refuses a :memory: path and names a file path', async () => {
  const root = await scratch({ 'migrations/001-seed.sql': 'CREATE TABLE t (v TEXT);' });

  try {
    await assert.rejects(migrate(root, {}), {
      message:
        /capabilities\.sqlite\.path is :memory:.*set capabilities\.sqlite\.path in murmur\.yaml to a file, e\.g\. sqlite:\.\/app\.db/,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the sqlite path takes a bare path, sqlite: and file: URLs, relative to the app root', () => {
  assert.equal(databasePath('/app', ':memory:'), ':memory:');
  assert.equal(databasePath('/app', 'sqlite::memory:'), ':memory:');
  assert.equal(databasePath('/app', './todo.db'), '/app/todo.db');
  assert.equal(databasePath('/app', 'sqlite:./data/todo.db'), '/app/data/todo.db');
  assert.equal(databasePath('/app', 'sqlite://./todo.db'), '/app/todo.db');
  assert.equal(databasePath('/app', 'file:///var/lib/todo%20app.db'), '/var/lib/todo app.db');
  assert.equal(databasePath('/app', 'file:todo.db'), '/app/todo.db');
});

test('the sqlite and kv sheets teach the callback transaction, insert, the one DDL source and incr', () => {
  const sheet = sqlite().docs ?? '';

  assert.match(sheet, /await db\.transaction\(async \(tx\) =>/);
  assert.match(sheet, /a nested `transaction\(fn\)` joins the outer one/);
  assert.match(sheet, /await db\.insert\('todos', /);
  assert.match(sheet, /`pieces\/\*\*\/schema\.sql` then `migrations\/\*\.sql`/);
  assert.match(sheet, /pnpm exec murmur migrate/);
  assert.match(sheet, /`sqlite:\.\/app\.db`/);
  assert.doesNotMatch(sheet, /await using/);
  assert.match(kv().docs ?? '', /await kv\.incr\('rate:ada', \{ windowMs: 60_000 \}\)/);
});
