import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { Sqlite } from '@murmur/node';
import { fakeLog, fakeSqlite } from '@murmur/node/testing';
import { Model } from 'murmur';
import { fakeClock } from 'murmur/testing';
import { z } from 'zod';

import { kv } from '../src/capabilities/kv.ts';
import { openDatabase, sqlite } from '../src/capabilities/sqlite.ts';
import { runContext } from '../src/context.ts';

const runA = {
  traceId: 'aaaaaaaa',
  hop: 0,
  piece: 'a',
  signal: new AbortController().signal,
  internal: false,
};

async function heldTransaction(db: Sqlite, release: Promise<void>): Promise<string> {
  return db
    .transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (?)', 'in-tx');
      await release;
      throw new Error('roll back');
    })
    .then(
      () => 'committed',
      (error: unknown) => String(error),
    );
}

test('a plain statement from another caller waits for the open transaction', async () => {
  const db = await fakeSqlite();
  await db.exec('CREATE TABLE t (v TEXT)');
  const release = Promise.withResolvers<void>();
  const held = runContext.run(runA, () => heldTransaction(db, release.promise));
  await delay(1);
  const outside = db.run('INSERT INTO t VALUES (?)', 'outside');
  await delay(5);
  release.resolve();
  assert.equal(await held, 'Error: roll back');
  await outside;
  assert.deepEqual(await db.all('SELECT v FROM t'), [{ v: 'outside' }]);
});

test('migrations apply once, in file order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'murmur-migrations-'));

  try {
    await writeFile(join(dir, '002-seed.sql'), "INSERT INTO t VALUES ('seed');");
    await writeFile(join(dir, '001-create.sql'), 'CREATE TABLE t (v TEXT);');
    const file = join(dir, 'app.db');
    const migrateOnce = async () => {
      const database = openDatabase(file);
      await database.migrate(dir);
      database.close();
    };
    await migrateOnce();
    await migrateOnce();
    const database = openDatabase(file);
    assert.deepEqual(await database.handle(runA).all('SELECT v FROM t'), [{ v: 'seed' }]);
    database.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

class Todo extends Model({ id: z.string(), title: z.string(), done: z.boolean() }) {}

test('the sqlite docs page shows real rows: a decoded Model, a plain row with integer booleans', async () => {
  const docs = sqlite().docs ?? '';
  const db = await fakeSqlite();
  await db.exec('CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL)');
  const inserted = await db.run('INSERT INTO todos (id, title, done) VALUES (?, ?, ?)', 't1', 'buy milk', 1);
  const sql = 'SELECT id, title, done FROM todos WHERE id = ?';
  assert.deepEqual(await db.row(Todo, sql, 't1'), { id: 't1', title: 'buy milk', done: true });
  assert.deepEqual(await db.get(sql, 't1'), { id: 't1', title: 'buy milk', done: 1 });
  assert.deepEqual(inserted, { changes: 1, lastInsertRowid: 1 });
  assert.equal(await db.row(Todo, sql, 'nope'), null);
  assert.equal(await db.get(sql, 'nope'), undefined);
  assert.ok(docs.includes("→ `{ id: 't1', title: 'buy milk', done: true }`"), docs);
  assert.ok(docs.includes("→ `{ id: 't1', title: 'buy milk', done: 1 }`"), docs);
  assert.ok(docs.includes('`{ changes: 1, lastInsertRowid: 1 }`'), docs);
  assert.match(docs, /no boolean type/);
});

async function rejectionWithin(work: Promise<unknown>, ms: number): Promise<string> {
  const outcome = Promise.allSettled([work]).then(([result]) => result);
  const settled = await Promise.race([outcome, delay(ms).then(() => undefined)]);

  if (settled === undefined) {
    assert.fail(`still pending after ${ms} ms`);
  }

  if (settled.status === 'fulfilled') {
    assert.fail('expected a rejection');
  }

  return String(settled.reason);
}

test('outside a run, a statement waits for the open out-of-run transaction instead of joining it', async () => {
  const db = await fakeSqlite();
  await db.exec('CREATE TABLE t (v TEXT)');
  const release = Promise.withResolvers<void>();
  const held = heldTransaction(db, release.promise);
  await delay(1);
  const outside = db.run('INSERT INTO t VALUES (?)', 'outside');
  await delay(5);
  release.resolve();
  assert.equal(await held, 'Error: roll back');
  await outside;
  assert.deepEqual(await db.all('SELECT v FROM t'), [{ v: 'outside' }]);
});

async function concurrentOutsideRun(gapMs: number): Promise<string[]> {
  const db = await fakeSqlite();
  await db.exec('CREATE TABLE t (v TEXT)');
  const write = (value: string) =>
    db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (?)', value);
      await delay(5);
    });
  const first = write('first');
  await delay(gapMs);
  const second = write('second');
  await Promise.all([first, second]);
  const rows = await db.all<{ v: string }>('SELECT v FROM t ORDER BY rowid');

  return rows.map((row) => row.v);
}

test('two out-of-run transactions queue and both commit in order, issued at once or later', async () => {
  assert.deepEqual(await concurrentOutsideRun(0), ['first', 'second']);
  assert.deepEqual(await concurrentOutsideRun(10), ['first', 'second']);
});

test('kv.once outside a run throws instead of hanging', async () => {
  const handle = await kv().start({
    config: { namespace: 'app' },
    needs: { sqlite: await fakeSqlite() },
    clock: fakeClock(),
  } as never);

  assert.match(
    await rejectionWithin(
      handle.once('id', () => 'sent'),
      200,
    ),
    /kv.once called outside a run/,
  );

  assert.deepEqual(await runContext.run(runA, () => handle.once('id', () => 'sent')), {
    first: true,
    value: 'sent',
  });
});

async function migrationDirectory(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'murmur-migrations-'));
  const entries = Object.entries(files);
  await Promise.all(entries.map(([path]) => mkdir(join(dir, path, '..'), { recursive: true })));
  await Promise.all(entries.map(([path, text]) => writeFile(join(dir, path), text)));

  return dir;
}

test('migration globs and literal files resolve against the root, apply in code point order and report empty globs', async () => {
  const dir = await migrationDirectory({
    'pieces/a/schema.sql': "INSERT INTO t VALUES ('a');",
    'pieces/B/schema.sql': "INSERT INTO t VALUES ('B');",
    'schema.sql': 'CREATE TABLE t (v TEXT);',
  });

  const database = openDatabase(':memory:');

  try {
    const plan = await database.migrate(['schema.sql', 'pieces/**/schema.sql', 'missing/**/*.sql'], dir);
    const names = await database.handle(runA).all<{ name: string }>('SELECT name FROM murmur_migrations');

    assert.deepEqual(
      plan.files.map((file) => file.name),
      ['schema.sql', 'pieces/B/schema.sql', 'pieces/a/schema.sql'],
    );
    assert.deepEqual(plan.unmatched, ['missing/**/*.sql']);
    assert.deepEqual(await database.handle(runA).all('SELECT v FROM t'), [{ v: 'B' }, { v: 'a' }]);
    assert.equal(names.length, 3);
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the sqlite capability warns when a configured migrations glob matches no file, never for the default list', async () => {
  const log = fakeLog();
  const root = await migrationDirectory({ 'schema.sql': 'CREATE TABLE t (v TEXT);' });
  const start = (migrations: string | readonly string[]) =>
    sqlite().start({ config: { path: ':memory:', busyTimeoutMs: 5000, migrations }, root, log } as never);

  const configured = await start('db/**/*.sql');
  const defaulted = await start(['pieces/**/schema.sql', 'migrations/*.sql']);
  await rm(root, { recursive: true, force: true });

  assert.deepEqual(
    log.records.map((record) => [record.level, record.message]),
    [['warn', 'sqlite migrations: db/**/*.sql matches no file']],
  );
  await sqlite().stop?.(configured, AbortSignal.timeout(1_000));
  await sqlite().stop?.(defaulted, AbortSignal.timeout(1_000));
});

test('a migration whose SQL fails names the file and keeps the sqlite error as cause', async () => {
  const dir = await migrationDirectory({ 'pieces/todos/schema.sql': 'CREATE TABLE (' });
  const database = openDatabase(':memory:');

  try {
    await assert.rejects(database.migrate('pieces/**/schema.sql', dir), (error: Error) => {
      assert.equal(error.name, 'SqliteError');
      assert.match(error.message, /^migration pieces\/todos\/schema.sql failed: .*syntax error/);
      assert.ok(error.cause instanceof Error);

      return true;
    });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a literal migration source that does not exist names the source and the root', async () => {
  const dir = await migrationDirectory({});
  const database = openDatabase(':memory:');

  try {
    await assert.rejects(database.migrate('db/schema.sql', dir), {
      name: 'SqliteError',
      message: `sqlite migrations: db/schema.sql not found under ${dir}`,
    });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
