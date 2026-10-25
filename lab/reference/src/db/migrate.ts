import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { insert, one, run } from './sql.ts';
import { POST_STEPS, migrationNow } from './post-steps.ts';
import { immediate } from './tx.ts';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

function applied(db: DatabaseSync, version: string): boolean {
  return one(db, 'SELECT 1 AS x FROM schema_migrations WHERE version = ?', version) !== undefined;
}

function apply(db: DatabaseSync, file: string): void {
  db.exec(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8'));
  POST_STEPS[file]?.(db, migrationNow(db));
  insert(db, 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', file, Date.now());
}

function seedSingletons(db: DatabaseSync): void {
  run(db, 'INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', 'cursor_secret', randomBytes(32).toString('hex'));
  run(db, 'INSERT OR IGNORE INTO clock (id, override_ms) VALUES (1, NULL)');
}

export function migrate(db: DatabaseSync): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

  return immediate(db, () => {
    const fresh = migrationFiles().filter((file) => !applied(db, file));
    for (const file of fresh) apply(db, file);
    seedSingletons(db);

    return fresh;
  });
}
