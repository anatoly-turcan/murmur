import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { one, run } from '../db/sql.ts';
import { immediate } from '../db/tx.ts';
import { canonicalJson } from './pagination.ts';

const TTL_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^[\x20-\x7e]{1,255}$/;

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type IdempotencyDecision =
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'reused' }
  | { kind: 'in_progress' }
  | { kind: 'reserved' };

interface KeyRow {
  fingerprint: string;
  state: 'in_progress' | 'done';
  status: number | null;
  headers: string | null;
  body: string | null;
  expires_at: number;
}

export function isValidIdempotencyKey(value: string): boolean {
  return KEY_RE.test(value);
}

export function fingerprint(method: string, path: string, bodyText: string, parsed: unknown): string {
  const canonical = parsed === undefined ? bodyText : canonicalJson(parsed);

  return createHash('sha256').update(`${method} ${path}\n${canonical}`).digest('hex');
}

function existing(db: DatabaseSync, scope: string, key: string, now: number): KeyRow | undefined {
  const row = one<KeyRow>(db, 'SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?', scope, key);

  return row && row.expires_at > now ? row : undefined;
}

function reserve(db: DatabaseSync, scope: string, key: string, fp: string, now: number): void {
  run(
    db,
    `INSERT INTO idempotency_keys (scope, key, fingerprint, state, created_at, expires_at) VALUES (?, ?, ?, 'in_progress', ?, ?)
     ON CONFLICT (scope, key) DO UPDATE SET fingerprint = excluded.fingerprint, state = 'in_progress', status = NULL,
       headers = NULL, body = NULL, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    scope,
    key,
    fp,
    now,
    now + TTL_MS,
  );
}

function decide(row: KeyRow, fp: string): IdempotencyDecision {
  if (row.state === 'in_progress') return { kind: 'in_progress' };
  if (row.fingerprint !== fp) return { kind: 'reused' };

  return { kind: 'replay', response: { status: row.status ?? 200, headers: JSON.parse(row.headers ?? '{}'), body: row.body ?? '' } };
}

export function lookupOrReserve(db: DatabaseSync, scope: string, key: string, fp: string, now: number): IdempotencyDecision {
  return immediate(db, () => {
    const row = existing(db, scope, key, now);
    if (row) return decide(row, fp);
    reserve(db, scope, key, fp, now);

    return { kind: 'reserved' };
  });
}

export function complete(db: DatabaseSync, scope: string, key: string, response: StoredResponse): void {
  run(
    db,
    `UPDATE idempotency_keys SET state = 'done', status = ?, headers = ?, body = ? WHERE scope = ? AND key = ?`,
    response.status,
    JSON.stringify(response.headers),
    response.body,
    scope,
    key,
  );
}

export function release(db: DatabaseSync, scope: string, key: string): void {
  run(db, `DELETE FROM idempotency_keys WHERE scope = ? AND key = ? AND state = 'in_progress'`, scope, key);
}
