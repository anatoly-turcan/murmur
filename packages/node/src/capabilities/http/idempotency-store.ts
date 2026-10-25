import type { Clock } from 'murmur';

import { openDatabase } from '../sqlite.ts';
import type { Sqlite } from '../types.ts';

export interface Claim {
  readonly scope: string;
  readonly key: string;
  readonly route: string;
  readonly fingerprint: string;
  readonly ttlMs: number;
  readonly deadline: number | undefined;
}

export interface StoredResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

export type ClaimOutcome =
  | { readonly kind: 'run'; readonly lock: number }
  | { readonly kind: 'inProgress' }
  | { readonly kind: 'reused' }
  | { readonly kind: 'replay'; readonly response: StoredResponse };

export interface IdempotencyStore {
  claim(claim: Claim): Promise<ClaimOutcome>;
  complete(claim: Claim, lock: number, response: StoredResponse): Promise<void>;
  release(claim: Claim, lock: number): Promise<void>;
}

interface Row {
  readonly state: string;
  readonly fingerprint: string;
  readonly status: number | null;
  readonly headers: string | null;
  readonly body: Uint8Array | null;
  readonly lockedUntil: number;
}

export const IDEMPOTENCY_SCHEMA = `CREATE TABLE IF NOT EXISTS murmur_idempotency (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  status INTEGER,
  headers TEXT,
  body BLOB,
  locked_until INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS murmur_idempotency_expiry ON murmur_idempotency (expires_at);`;

const DEFAULT_LOCK_MS = 30_000;

const SWEEP = 'DELETE FROM murmur_idempotency WHERE expires_at < ?';

const FIND = `SELECT state, fingerprint, status, headers, body, locked_until AS lockedUntil
  FROM murmur_idempotency WHERE scope = ? AND key = ?`;

const INSERT = `INSERT INTO murmur_idempotency (scope, key, route, fingerprint, state, locked_until, expires_at)
  VALUES (?, ?, ?, ?, 'running', ?, ?)`;

const RECLAIM = `UPDATE murmur_idempotency SET route = ?, fingerprint = ?, locked_until = ?, expires_at = ?
  WHERE scope = ? AND key = ?`;

const COMPLETE = `UPDATE murmur_idempotency SET state = 'completed', status = ?, headers = ?, body = ?, expires_at = ?
  WHERE scope = ? AND key = ? AND state = 'running' AND locked_until = ?`;

const RELEASE = `DELETE FROM murmur_idempotency
  WHERE scope = ? AND key = ? AND state = 'running' AND locked_until = ?`;

function storedOf(row: Row): StoredResponse {
  return {
    status: row.status ?? 200,
    headers: JSON.parse(row.headers ?? '[]') as [string, string][],
    body: row.body ?? new Uint8Array(),
  };
}

function settled(row: Row, claim: Claim): ClaimOutcome {
  if (row.fingerprint !== claim.fingerprint) {
    return { kind: 'reused' };
  }

  return { kind: 'replay', response: storedOf(row) };
}

async function decide(tx: Sqlite, claim: Claim, now: number): Promise<ClaimOutcome> {
  await tx.run(SWEEP, now);
  const row = await tx.get<Row>(FIND, claim.scope, claim.key);
  const lock = claim.deadline ?? now + DEFAULT_LOCK_MS;
  const expiresAt = now + claim.ttlMs;

  if (row === undefined) {
    await tx.run(INSERT, claim.scope, claim.key, claim.route, claim.fingerprint, lock, expiresAt);

    return { kind: 'run', lock };
  }

  if (row.state !== 'running') {
    return settled(row, claim);
  }

  if (row.lockedUntil > now) {
    return { kind: 'inProgress' };
  }

  await tx.run(RECLAIM, claim.route, claim.fingerprint, lock, expiresAt, claim.scope, claim.key);

  return { kind: 'run', lock };
}

export function idempotencyStore(sql: Sqlite, clock: Clock): IdempotencyStore {
  let ready: Promise<void> | undefined;
  const prepared = () => {
    ready ??= sql.exec(IDEMPOTENCY_SCHEMA);

    return ready;
  };
  const now = () => clock.now().epochMilliseconds;

  return {
    claim: async (claim) => {
      await prepared();

      return sql.transaction((tx) => decide(tx, claim, now()));
    },
    complete: async (claim, lock, response) => {
      await sql.run(
        COMPLETE,
        response.status,
        JSON.stringify(response.headers),
        response.body,
        now() + claim.ttlMs,
        claim.scope,
        claim.key,
        lock,
      );
    },
    release: async (claim, lock) => {
      await sql.run(RELEASE, claim.scope, claim.key, lock);
    },
  };
}

export function memoryIdempotencyStore(clock: Clock): IdempotencyStore {
  let store: IdempotencyStore | undefined;
  const opened = () => {
    store ??= idempotencyStore(openDatabase(':memory:').handle(), clock);

    return store;
  };

  return {
    claim: (claim) => opened().claim(claim),
    complete: (claim, lock, response) => opened().complete(claim, lock, response),
    release: (claim, lock) => opened().release(claim, lock),
  };
}
