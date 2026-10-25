import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ambientSqlite, openDatabase, sqlite } from '../src/capabilities/sqlite.ts';
import { migrate } from '../src/migrate.ts';
import { writeLoop } from './fixtures/sqlite/writer.ts';

const WRITER = join(import.meta.dirname, 'fixtures', 'sqlite', 'writer.ts');
const WRITES = 150;

interface Child {
  readonly ready: Promise<void>;
  readonly exited: Promise<number | null>;
  readonly stderr: () => string;
  readonly stdout: () => string;
}

function spawnWriter(file: string, args: readonly string[]): Child {
  const child = spawn(process.execPath, [WRITER, file, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const ready = new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();

      if (stdout.includes('ready')) {
        resolve();
      }
    });
  });

  return {
    ready,
    exited: once(child, 'close').then(([code]) => code as number | null),
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

async function tempFile(): Promise<{ file: string; [Symbol.asyncDispose](): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'murmur-sqlite-'));

  return {
    file: join(dir, 'app.db'),
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  };
}

test(
  'two processes writing one file in transaction loops never see SQLITE_BUSY',
  { timeout: 60_000 },
  async () => {
    await using temp = await tempFile();
    const database = openDatabase(temp.file);
    const db = ambientSqlite(database);
    await db.exec('CREATE TABLE writes (writer TEXT NOT NULL, n INTEGER NOT NULL, seen INTEGER NOT NULL)');
    const child = spawnWriter(temp.file, ['write', 'child', String(WRITES)]);
    await child.ready;

    const parent = await writeLoop(db, 'parent', WRITES).then(
      () => 'ok',
      (error: unknown) => String(error),
    );

    const code = await child.exited;

    const rows = await db.all<{ writer: string; total: number }>(
      'SELECT writer, COUNT(*) AS total FROM writes GROUP BY writer ORDER BY writer',
    );

    database.close();

    assert.equal(parent, 'ok');
    assert.doesNotMatch(child.stderr(), /database is locked|SQLITE_BUSY/);
    assert.equal(code, 0, child.stderr());
    assert.deepEqual(rows, [
      { writer: 'child', total: WRITES },
      { writer: 'parent', total: WRITES },
    ]);
  },
);

test('a file database runs in WAL mode with synchronous NORMAL and the configured busy timeout', async () => {
  await using temp = await tempFile();
  const database = openDatabase(temp.file, { busyTimeoutMs: 1234 });
  const db = ambientSqlite(database);

  assert.deepEqual(await db.get('PRAGMA journal_mode'), { journal_mode: 'wal' });
  assert.deepEqual(await db.get('PRAGMA synchronous'), { synchronous: 1 });
  assert.deepEqual(await db.get('PRAGMA busy_timeout'), { timeout: 1234 });
  database.close();
});

test('an in-memory database keeps its journal mode and takes the default busy timeout', async () => {
  const database = openDatabase(':memory:');
  const db = ambientSqlite(database);

  assert.deepEqual(await db.get('PRAGMA journal_mode'), { journal_mode: 'memory' });
  assert.deepEqual(await db.get('PRAGMA busy_timeout'), { timeout: 5000 });
  database.close();
});

test('the sqlite sheet documents busyTimeoutMs, WAL and BEGIN IMMEDIATE', () => {
  const docs = sqlite().docs ?? '';

  assert.match(docs, /`busyTimeoutMs` \(default 5000\)/);
  assert.match(docs, /WAL/);
  assert.match(docs, /BEGIN IMMEDIATE/);
  assert.match(docs, /several processes/);
});

test(
  'two processes running migrate() on one file at once apply each migration once',
  { timeout: 30_000 },
  async () => {
    await using temp = await tempFile();
    const root = join(temp.file, '..');
    await mkdir(join(root, 'migrations'));
    await mkdir(join(root, 'pieces', 'todos'), { recursive: true });
    await writeFile(join(root, 'pieces', 'todos', 'schema.sql'), 'CREATE TABLE t (v TEXT);');
    await writeFile(join(root, 'migrations', '001-seed.sql'), "INSERT INTO t VALUES ('seed');");
    const database = openDatabase(temp.file);
    const child = spawnWriter(temp.file, ['migrate', root]);
    await child.ready;
    const parent = await migrate(root, { MURMUR__CAP_SQLITE__PATH: temp.file });
    const code = await child.exited;
    const rows = await ambientSqlite(database).all('SELECT v FROM t');
    const applied = await ambientSqlite(database).all('SELECT COUNT(*) AS total FROM murmur_migrations');
    database.close();
    const byChild = JSON.parse(/applied (.*)/.exec(child.stdout())?.[1] ?? '[]') as string[];

    assert.equal(code, 0, child.stderr());
    assert.deepEqual([...parent.applied, ...byChild].toSorted(), [
      'migrations/001-seed.sql',
      'pieces/todos/schema.sql',
    ]);
    assert.deepEqual(rows, [{ v: 'seed' }]);
    assert.deepEqual(applied, [{ total: 2 }]);
  },
);
