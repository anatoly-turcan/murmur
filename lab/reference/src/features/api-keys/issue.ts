import type { DatabaseSync } from 'node:sqlite';
import { one, run } from '../../db/sql.ts';
import type { ApiKeyRow } from '../../domain/rows.ts';
import { generateSecret, hashSecret, keyPrefix } from '../../http/auth.ts';
import { newId, type Id } from '../../ids/uuid.ts';

export interface IssuedKey {
  row: ApiKeyRow;
  secret: string;
}

export function issueApiKey(db: DatabaseSync, userId: Id, name: string, now: number): IssuedKey {
  const secret = generateSecret();
  const id = newId(now);
  run(
    db,
    'INSERT INTO api_keys (id, user_id, name, prefix, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    userId,
    name,
    keyPrefix(secret),
    hashSecret(secret),
    now,
  );

  return { row: one<ApiKeyRow>(db, 'SELECT * FROM api_keys WHERE id = ?', id)!, secret };
}
