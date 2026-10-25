import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
];

export function databasePath(url: string): string {
  if (url.startsWith('sqlite://')) return url.slice('sqlite://'.length);
  if (url.startsWith('sqlite:')) return url.slice('sqlite:'.length);
  if (url.startsWith('file:')) return url.slice('file:'.length);

  return url;
}

export function openDatabase(url: string): DatabaseSync {
  const path = resolve(databasePath(url));
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  for (const pragma of PRAGMAS) db.exec(pragma);

  return db;
}
