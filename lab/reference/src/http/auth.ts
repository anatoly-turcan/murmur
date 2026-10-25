import { createHash, randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { one, run } from '../db/sql.ts';
import type { UserRow } from '../domain/rows.ts';
import type { Id } from '../ids/uuid.ts';

const HEADER_RE = /^Bearer (twl_[A-Za-z0-9]{40})$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOUCH_INTERVAL_MS = 60_000;

export type AuthResult = { kind: 'ok'; user: UserRow; keyId: Id } | { kind: 'missing' } | { kind: 'invalid' };

interface KeyLookup extends UserRow {
  key_id: Id;
  key_last_used_at: number | null;
  key_revoked_at: number | null;
}

export function generateSecret(): string {
  let out = 'twl_';
  for (let i = 0; i < 40; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];

  return out;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function keyPrefix(secret: string): string {
  return secret.slice(0, 12);
}

function lookup(db: DatabaseSync, secret: string): KeyLookup | undefined {
  return one<KeyLookup>(
    db,
    `SELECT u.*, k.id AS key_id, k.last_used_at AS key_last_used_at, k.revoked_at AS key_revoked_at
       FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.secret_hash = ?`,
    hashSecret(secret),
  );
}

function toUser(row: KeyLookup): UserRow {
  const { key_id: _a, key_last_used_at: _b, key_revoked_at: _c, ...user } = row;

  return user;
}

export function touchLastUsed(db: DatabaseSync, keyId: Id, lastUsedAt: number | null, now: number): void {
  if (lastUsedAt !== null && now - lastUsedAt < TOUCH_INTERVAL_MS && now >= lastUsedAt) return;
  run(db, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', now, keyId);
}

export function authenticate(db: DatabaseSync, header: string | undefined, now: number): AuthResult {
  const match = header === undefined ? null : HEADER_RE.exec(header);
  if (!match) return { kind: 'missing' };
  const row = lookup(db, match[1]);
  if (!row || row.key_revoked_at !== null || row.deactivated_at !== null) return { kind: 'invalid' };
  touchLastUsed(db, row.key_id, row.key_last_used_at, now);

  return { kind: 'ok', user: toUser(row), keyId: row.key_id };
}
