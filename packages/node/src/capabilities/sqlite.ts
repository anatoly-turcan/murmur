import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { defineCapability, type Log } from 'murmur';
import { z } from 'zod';

import { messageOf } from '../loader/import.ts';
import { inSequence } from '../sequence.ts';
import { ambientHolder } from './holder.ts';
import {
  DEFAULT_MIGRATIONS,
  planMigrations,
  type MigrationFile,
  type MigrationPlan,
  type MigrationReport,
} from './migrations.ts';
import { SqliteError } from './sqlite-error.ts';
import { decodeRow, type Row } from './sqlite-rows.ts';
import { callableToken } from './token.ts';
import type { Sqlite, SqliteRunResult } from './types.ts';

export { SqliteError } from './sqlite-error.ts';

type Release = () => void;
type HolderOf = () => unknown;

interface Lock {
  holder: unknown;
  tail: Promise<void>;
}

export interface Database {
  readonly brand: 'murmur.sqlite';
  handle(holder?: unknown): Sqlite;
  handleFor(holderNow: HolderOf): Sqlite;
  transaction<T>(holder: unknown, work: () => Promise<T>): Promise<T>;
  peek<T>(sql: string, ...values: unknown[]): T | undefined;
  migrate(sources: string | readonly string[], root?: string): Promise<MigrationReport>;
  close(): void;
}

function acquire(lock: Lock, holder: unknown = {}): Promise<Release> {
  const previous = lock.tail;
  const turn = Promise.withResolvers<void>();
  lock.tail = previous.then(() => turn.promise);
  let released = false;

  return previous.then(() => {
    lock.holder = holder;

    return () => {
      if (released) {
        return;
      }

      released = true;
      lock.holder = undefined;
      turn.resolve();
    };
  });
}

function params(values: readonly unknown[]): SQLInputValue[] {
  return values as SQLInputValue[];
}

function plain<T>(row: T): T {
  return row === undefined ? row : { ...row };
}

function statements(database: DatabaseSync) {
  return {
    run: (sql: string, values: readonly unknown[]): SqliteRunResult => {
      const result = database.prepare(sql).run(...params(values));

      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    },
    get: (sql: string, values: readonly unknown[]): unknown =>
      plain(database.prepare(sql).get(...params(values))),
    all: (sql: string, values: readonly unknown[]): unknown[] =>
      database
        .prepare(sql)
        .all(...params(values))
        .map(plain),
    exec: (sql: string): void => database.exec(sql),
  };
}

type Statements = ReturnType<typeof statements>;

const BEGIN = 'BEGIN IMMEDIATE';

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface OpenOptions {
  readonly busyTimeoutMs?: number;
}

const LOST_CONTEXT =
  'the async context is lost (EventEmitter listener, ReadableStream.cancel, timer); move the work into a handler or onStart';

export function outsideRun(operation: string): SqliteError {
  return new SqliteError(`${operation} called outside a run: ${LOST_CONTEXT}`);
}

async function locked<T>(lock: Lock, holder: unknown, work: () => T | Promise<T>): Promise<T> {
  const release = await acquire(lock, holder);

  try {
    return await work();
  } finally {
    release();
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function identifier(name: string, what: 'table' | 'column'): string {
  if (!IDENTIFIER.test(name)) {
    throw new SqliteError(
      `db.insert: ${what} "${name}" is not a plain identifier; use letters, digits and _ (write anything else as SQL with db.run)`,
    );
  }

  return `"${name}"`;
}

function singleKey(sql: Statements, table: string): string | undefined {
  const columns = sql.all(`PRAGMA table_info(${table})`, []) as { name: string; pk: number }[];
  const keys = columns.filter((column) => column.pk > 0);

  return keys.length === 1 ? keys[0]?.name : undefined;
}

function insertRow(sql: Statements, table: string, row: Row): number | string {
  const quoted = identifier(table, 'table');
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  const columns = entries.map(([column]) => identifier(column, 'column')).join(', ');
  const text =
    entries.length === 0
      ? `INSERT INTO ${quoted} DEFAULT VALUES`
      : `INSERT INTO ${quoted} (${columns}) VALUES (${entries.map(() => '?').join(', ')})`;
  const result = sql.run(
    text,
    entries.map(([, value]) => value),
  );
  const key = singleKey(sql, quoted);
  const given = key === undefined ? undefined : row[key];

  if (typeof given === 'string' || typeof given === 'number') {
    return given;
  }

  return Number(result.lastInsertRowid);
}

const openTransaction = new AsyncLocalStorage<unknown>();

function createHandle(sql: Statements, lock: Lock, ambient: HolderOf): Sqlite {
  const holderNow = () => ambient() ?? openTransaction.getStore();
  const owns = () => {
    const holder = holderNow();

    return holder !== undefined && lock.holder === holder;
  };
  const statement = async <T>(work: () => T): Promise<T> => {
    if (owns()) {
      return work();
    }

    return locked(lock, holderNow(), work);
  };

  return {
    run: (text, ...values) => statement(() => sql.run(text, values)),
    get: <T>(text: string, ...values: unknown[]) => statement(() => sql.get(text, values) as T | undefined),
    all: <T>(text: string, ...values: unknown[]) => statement(() => sql.all(text, values) as T[]),
    rows: (model, text, ...values) =>
      statement(() => sql.all(text, values).map((row) => decodeRow(model, 'rows', row as Row))),
    row: (model, text, ...values) =>
      statement(() => {
        const row = sql.get(text, values);

        return row === undefined ? null : decodeRow(model, 'row', row as Row);
      }),
    exec: (text) => statement(() => sql.exec(text)),
    insert: (table, row) => statement(() => insertRow(sql, table, row)),
    transaction: <T>(work: (tx: Sqlite) => Promise<T>) => {
      const holder = holderNow() ?? {};

      return openTransaction.run(holder, () =>
        inTransaction(sql, lock, holder, () => work(createHandle(sql, lock, () => holder))),
      );
    },
  };
}

async function inTransaction<T>(
  sql: Statements,
  lock: Lock,
  holder: unknown,
  work: () => Promise<T>,
): Promise<T> {
  if (holder !== undefined && lock.holder === holder) {
    return work();
  }

  const release = await acquire(lock, holder);

  try {
    sql.exec(BEGIN);

    return await committed(sql, work);
  } finally {
    release();
  }
}

async function committed<T>(sql: Statements, work: () => Promise<T>): Promise<T> {
  try {
    const value = await work();
    sql.exec('COMMIT');

    return value;
  } catch (error) {
    sql.exec('ROLLBACK');
    throw error;
  }
}

function appliedNames(sql: Statements): Set<string> {
  sql.exec('CREATE TABLE IF NOT EXISTS murmur_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const rows = sql.all('SELECT name FROM murmur_migrations', []) as { name: string }[];

  return new Set(rows.map((row) => row.name));
}

async function applyMigration(sql: Statements, lock: Lock, file: MigrationFile): Promise<boolean> {
  const text = await readFile(file.path, 'utf8');

  try {
    return await inTransaction(sql, lock, {}, async () => {
      if (sql.get('SELECT 1 AS applied FROM murmur_migrations WHERE name = ?', [file.name]) !== undefined) {
        return false;
      }

      sql.exec(text);
      sql.run('INSERT INTO murmur_migrations (name, applied_at) VALUES (?, ?)', [
        file.name,
        new Date().toISOString(),
      ]);

      return true;
    });
  } catch (cause) {
    throw new SqliteError(`migration ${file.name} failed: ${messageOf(cause)}`, { cause });
  }
}

function asList(sources: string | readonly string[]): readonly string[] {
  if (typeof sources === 'string') {
    return [sources];
  }

  return sources;
}

async function migrate(
  sql: Statements,
  lock: Lock,
  sources: string | readonly string[],
  root: string,
): Promise<MigrationReport> {
  const plan = await planMigrations(root, asList(sources));
  const done = appliedNames(sql);
  const pending = plan.files.filter((file) => !done.has(file.name));

  const outcomes = await inSequence(pending, async (file) =>
    (await applyMigration(sql, lock, file)) ? [file.name] : [],
  );

  return { ...plan, applied: outcomes.flat() };
}

function connect(path: string, options: OpenOptions): DatabaseSync {
  const database = new DatabaseSync(path, { timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS });
  if (path !== ':memory:') {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = NORMAL');
  }

  return database;
}

export function openDatabase(path: string, options: OpenOptions = {}): Database {
  const database = connect(path, options);
  const sql = statements(database);
  const lock: Lock = { holder: undefined, tail: Promise.resolve() };

  return {
    brand: 'murmur.sqlite',
    handle: (holder) => createHandle(sql, lock, () => holder),
    handleFor: (holderNow) => createHandle(sql, lock, holderNow),
    transaction: (holder, work) => inTransaction(sql, lock, holder, work),
    peek: <T>(text: string, ...values: unknown[]) => sql.get(text, values) as T | undefined,
    migrate: (sources, root = process.cwd()) => migrate(sql, lock, sources, root),
    close: () => database.close(),
  };
}

const databases = new WeakMap<object, Database>();

function isDatabase(value: unknown): value is Database {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'brand') === 'murmur.sqlite';
}

export function asDatabase(value: unknown): Database {
  if (isDatabase(value)) {
    return value;
  }

  const linked = typeof value === 'object' && value !== null ? databases.get(value) : undefined;
  if (linked === undefined) {
    throw new SqliteError('expected the sqlite capability instance');
  }

  return linked;
}

export function ambientSqlite(database: Database): Sqlite {
  const handle = database.handleFor(ambientHolder);
  databases.set(handle, database);

  return handle;
}

const SQLITE_DOCS = `# sqlite

The sqlite handle: one node:sqlite connection per process behind an async mutex. The piece names the field
(\`needs: { db: sqlite }\` → \`this.db\`); the examples below call it \`db\`. Safe when several processes share one
file: a file database runs in WAL mode (\`synchronous=NORMAL\`), every transaction starts with \`BEGIN IMMEDIATE\`, and
a write that finds the file locked by another process waits up to \`busyTimeoutMs\` instead of failing with
\`database is locked\` (the wait blocks this process).

- \`await db.row(Todo, 'SELECT id, title, done FROM todos WHERE id = ?', id)\` → \`{ id: 't1', title: 'buy milk', done: true }\`
  (\`null\` when no row); \`await db.rows(Todo, sql, ...params)\` → \`Todo[]\`. Decoded by the Model's field types:
  INTEGER 0/1 → a \`z.boolean()\` field, JSON TEXT → a \`z.array/z.object/z.record\` field, every other column as is,
  extra columns dropped. Column names equal field names: alias in SQL (\`created_at AS createdAt\`); a missing column
  throws naming it. No column selection, query building or relations: computed fields stay your code.
- \`get/all\` return plain rows keyed by column name. SQLite has no boolean type (store \`0\`/\`1\`, JSON with
  \`JSON.stringify\`): \`await db.get(sql, id)\` → \`{ id: 't1', title: 'buy milk', done: 1 }\` (\`undefined\` when no row).
- \`run\` → \`{ changes: 1, lastInsertRowid: 1 }\`; params are positional \`?\` values (string, number, bigint, null, Uint8Array).
- \`await db.insert('todos', { id: 't1', title: 'buy milk', done: 0 })\` → \`'t1'\`: keys are column names; it returns
  the primary key you gave, else \`lastInsertRowid\` as a number.
- \`run/get/all/rows/row/exec/insert\` are async; each waits for any open transaction of another delivery.
- \`const id = await db.transaction(async (tx) => { …; return id; })\`: \`BEGIN IMMEDIATE\`, commit when the callback
  returns (its value is the result), rollback when it throws. Run statements on \`tx\`; \`this.db.*\` and \`kv.once\` of
  the same delivery, or awaited inside the callback, join it, and a nested \`transaction(fn)\` joins the outer one
  (one commit, no savepoint: the outer rollback undoes the inner writes, and a nested call that throws does not roll
  back on its own; let the error reach the outer callback). Work started elsewhere (another delivery, a timer firing
  after \`onStart\` returned) waits until the transaction ends.
- One DDL source: \`migrations\` defaults to \`pieces/**/schema.sql\` then \`migrations/*.sql\`, each file applied once in
  path order and recorded by relative path in \`murmur_migrations\`. Boot and \`pnpm exec murmur migrate\` run the same
  list under \`BEGIN IMMEDIATE\`, so processes booting together apply each file once. \`murmur_*\` tables belong to the
  framework.
- Config: \`path\` (default \`:memory:\`; a bare path, \`sqlite:./app.db\` or \`file:///srv/app.db\`, relative to the app
  root, not the cwd), \`busyTimeoutMs\` (default 5000), \`migrations\` (globs, files or a directory of *.sql; replaces
  the default list).
`;

export const sqliteConfig = z.object({
  path: z.string().default(':memory:'),
  busyTimeoutMs: z.number().int().nonnegative().default(DEFAULT_BUSY_TIMEOUT_MS),
  migrations: z.union([z.string(), z.array(z.string())]).default([...DEFAULT_MIGRATIONS]),
});

export type SqliteConfig = z.output<typeof sqliteConfig>;

interface SqliteStart {
  readonly config: SqliteConfig;
  readonly root: string;
  readonly log: Log;
}

export function unmatchedSources(plan: MigrationPlan): string[] {
  return plan.unmatched.filter((source) => !DEFAULT_MIGRATIONS.includes(source));
}

function warnUnmatched(log: Log, plan: MigrationPlan): void {
  for (const pattern of unmatchedSources(plan)) {
    log.warn(`sqlite migrations: ${pattern} matches no file`, { pattern });
  }
}

const SCHEME = /^(?:sqlite|file):/;

export function databasePath(root: string, path: string): string {
  const url = SCHEME.test(path);
  const bare = path.replace(SCHEME, '');

  if (bare === ':memory:') {
    return bare;
  }

  const local = url && bare.startsWith('//') ? bare.slice(2) : bare;

  return resolve(root, url ? decodeURIComponent(local) : local);
}

export function openConfigured(root: string, config: SqliteConfig): Database {
  return openDatabase(databasePath(root, config.path), { busyTimeoutMs: config.busyTimeoutMs });
}

async function startSqlite({ config, root, log }: SqliteStart): Promise<Sqlite> {
  const database = openConfigured(root, config);
  warnUnmatched(log, await database.migrate(config.migrations, root));

  return ambientSqlite(database);
}

export const sqlite = callableToken(
  defineCapability({
    name: 'sqlite',
    config: sqliteConfig,
    docs: SQLITE_DOCS,
    start: ({ config, root, log }) => startSqlite({ config, root, log }),
    stop: (handle) => asDatabase(handle).close(),
    fake: async ({ root, pieceDir }) =>
      (await import('../testing/fakes.ts')).fakeSqlite({ schema: 'app', root, pieceDir }),
  }),
);
