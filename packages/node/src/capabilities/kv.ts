import { defineCapability, MurmurError, type Clock } from 'murmur';
import { z } from 'zod';

import { ambientHolder } from './holder.ts';
import { asDatabase, outsideRun, type Database } from './sqlite.ts';
import { callableToken } from './token.ts';
import type { Kv, OnceResult } from './types.ts';

interface KvStore {
  readonly database: Database;
  readonly namespace: string;
  readonly clock: Clock;
}

type Kind = 'value' | 'once' | 'counter';

const SCHEMA = `CREATE TABLE IF NOT EXISTS murmur_kv (
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (namespace, kind, key)
)`;

const SELECT = `SELECT value FROM murmur_kv
  WHERE namespace = ? AND kind = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)`;

const UPSERT = `INSERT INTO murmur_kv (namespace, kind, key, value, expires_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (namespace, kind, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`;

const DELETE = 'DELETE FROM murmur_kv WHERE namespace = ? AND kind = ? AND key = ?';

const INCR = `INSERT INTO murmur_kv (namespace, kind, key, value, expires_at) VALUES (?, 'counter', ?, '1', ?)
  ON CONFLICT (namespace, kind, key) DO UPDATE SET
    value = CASE WHEN murmur_kv.expires_at = excluded.expires_at THEN CAST(murmur_kv.value AS INTEGER) + 1 ELSE 1 END,
    expires_at = excluded.expires_at
  RETURNING value`;

function now(store: KvStore): number {
  return store.clock.now().epochMilliseconds;
}

function expiresAt(store: KvStore, ttlMs: number | undefined): number | null {
  return ttlMs === undefined ? null : now(store) + ttlMs;
}

export function windowEnd(nowMs: number, windowMs: number): number {
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new MurmurError(
      `kv.incr: windowMs must be a positive integer of milliseconds, e.g. { windowMs: 60_000 }; got ${windowMs}`,
      { code: 'kv-window', retryable: false },
    );
  }

  return (Math.floor(nowMs / windowMs) + 1) * windowMs;
}

function kvHandle(store: KvStore, holder: () => unknown): Kv {
  const sql = store.database.handleFor(holder);
  const { namespace } = store;
  const read = (kind: Kind, key: string) =>
    sql.get<{ value: string }>(SELECT, namespace, kind, key, now(store));
  const write = (kind: Kind, key: string, value: unknown, ttlMs: number | undefined) =>
    sql.run(UPSERT, namespace, kind, key, JSON.stringify(value) ?? 'null', expiresAt(store, ttlMs));

  return {
    get: async <T>(key: string) => {
      const row = await read('value', key);

      return row === undefined ? undefined : (JSON.parse(row.value) as T);
    },
    set: async (key, value, options) => {
      await write('value', key, value, options?.ttlMs);
    },
    delete: async (key) => {
      await sql.run(DELETE, namespace, 'value', key);
    },
    once: async <T>(id: string, effect: () => T | Promise<T>, options?: { ttlMs?: number }) => {
      const owner = holder();
      if (owner === undefined) {
        throw outsideRun('kv.once');
      }

      return store.database.transaction(owner, async (): Promise<OnceResult<T>> => {
        if ((await read('once', id)) !== undefined) {
          return { first: false };
        }

        await write('once', id, null, options?.ttlMs);

        return { first: true, value: await effect() };
      });
    },
    incr: async (key, { windowMs }) => {
      const resetMs = windowEnd(now(store), windowMs);
      const row = await sql.get<{ value: string | number }>(INCR, namespace, key, resetMs);

      return { count: Number(row?.value), resetAt: Temporal.Instant.fromEpochMilliseconds(resetMs) };
    },
  };
}

const KV_DOCS = `# kv

The kv handle: JSON values in the sqlite table \`murmur_kv\`, shared connection and mutex with sqlite. The piece
names the field (\`needs: { kv }\` → \`this.kv\`); the examples below call it \`kv\`.

- \`get/set/delete\`, optional \`{ ttlMs }\` on \`set\`; \`get\` returns the stored JSON value as set
  (\`{ count: 2 }\`), \`undefined\` when missing or expired.
- \`await kv.once(delivery.envelope.id, () => 'sent')\` → \`{ first: true, value: 'sent' }\`, on redelivery \`{ first: false }\`.
- \`once(id, effect)\`: marker and effect commit in one sqlite transaction; a throwing effect rolls the marker
  back so the retry runs it again; an existing marker returns \`{ first: false }\` without running \`effect\`.
- Inside \`effect\`, sqlite calls of the same delivery join the transaction. Effects outside sqlite stay at-least-once.
- \`const { count, resetAt } = await kv.incr('rate:ada', { windowMs: 60_000 })\` → \`{ count: 1, resetAt }\`
  (\`Temporal.Instant\`): one atomic fixed-window counter shared by every process on the file. The window is
  \`floor(now / windowMs)\` on the runtime clock; the next window starts again at 1. Key choice and headers stay yours.
- Config: \`namespace\` (default \`app\`).
`;

async function startKv(store: KvStore): Promise<Kv> {
  await store.database.handle().exec(SCHEMA);

  return kvHandle(store, ambientHolder);
}

export const kv = callableToken(
  defineCapability({
    name: 'kv',
    needs: ['sqlite'],
    config: z.object({ namespace: z.string().default('app') }),
    docs: KV_DOCS,
    start: ({ config, needs, clock }) =>
      startKv({ database: asDatabase(needs['sqlite']), namespace: config.namespace, clock }),
    fake: async ({ clock }) => (await import('../testing/fakes.ts')).fakeKv(clock),
  }),
);
