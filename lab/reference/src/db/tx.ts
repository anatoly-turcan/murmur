import type { DatabaseSync } from 'node:sqlite';

const depth = new WeakMap<DatabaseSync, number>();

export function inTransaction(db: DatabaseSync): boolean {
  return (depth.get(db) ?? 0) > 0;
}

export function immediate<T>(db: DatabaseSync, fn: () => T): T {
  if (inTransaction(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');

    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}
