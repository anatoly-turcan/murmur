import type { DatabaseSync } from 'node:sqlite';
import { one, run } from '../db/sql.ts';

export function readOverride(db: DatabaseSync): number | null {
  return one<{ override_ms: number | null }>(db, 'SELECT override_ms FROM clock WHERE id = 1')?.override_ms ?? null;
}

export function appNow(db: DatabaseSync, testMode: boolean): number {
  if (!testMode) return Date.now();

  return readOverride(db) ?? Date.now();
}

export function setOverride(db: DatabaseSync, ms: number | null): void {
  run(db, 'UPDATE clock SET override_ms = ? WHERE id = 1', ms);
}
