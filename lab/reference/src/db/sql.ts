import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

export type SqlValue = SQLInputValue;

const caches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

export function statement(db: DatabaseSync, sql: string): StatementSync {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }

  return stmt;
}

export function one<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): T | undefined {
  return statement(db, sql).get(...params) as T | undefined;
}

export function all<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): T[] {
  return statement(db, sql).all(...params) as T[];
}

export function run(db: DatabaseSync, sql: string, ...params: SqlValue[]): number {
  return Number(statement(db, sql).run(...params).changes);
}

export function insert(db: DatabaseSync, sql: string, ...params: SqlValue[]): number {
  return Number(statement(db, sql).run(...params).lastInsertRowid);
}

export function scalar<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): T | undefined {
  const row = statement(db, sql).get(...params) as Record<string, unknown> | undefined;

  return row === undefined ? undefined : (Object.values(row)[0] as T);
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export function bool(value: boolean): number {
  return value ? 1 : 0;
}
