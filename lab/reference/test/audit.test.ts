import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { requestContext, withAuditContext } from '../src/audit/context.ts';
import { diffOf } from '../src/audit/diff.ts';
import { audited, auditCreated } from '../src/audit/record.ts';
import { migrate } from '../src/db/migrate.ts';
import { all, run } from '../src/db/sql.ts';
import { immediate } from '../src/db/tx.ts';
import type { UserRow } from '../src/domain/rows.ts';

interface EntryRow {
  actor_type: string;
  actor_id: string | null;
  request_id: string | null;
  ip: string | null;
  action: string;
  before: string | null;
  diff: string;
}

function world(): { db: DatabaseSync; user: UserRow } {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  run(db, `INSERT INTO users (id, email, email_key, name, timezone, created_at, updated_at) VALUES ('u-1', 'a@example.com', 'a@example.com', 'Ana', 'UTC', 0, 0)`);
  const user = { id: 'u-1', email: 'a@example.com', email_key: 'a@example.com', name: 'Ana', timezone: 'UTC', digest_enabled: 1, created_at: 0, updated_at: 0, deactivated_at: null };

  return { db, user };
}

function entries(db: DatabaseSync): EntryRow[] {
  return all<EntryRow>(db, 'SELECT * FROM audit_entries ORDER BY occurred_at, id');
}

function rename(db: DatabaseSync, name: string): void {
  run(db, 'UPDATE users SET name = ?, updated_at = updated_at + 1 WHERE id = ?', name, 'u-1');
}

test('diff skips bookkeeping and derived fields and compares arrays as whole values', () => {
  const before = { status: 'open', labels: ['ui'], version: 1, updated_at: 'a', completed_at: null };
  const after = { status: 'done', labels: ['bug', 'ui'], version: 2, updated_at: 'b', completed_at: 'c' };
  assert.deepEqual(diffOf('task', before, after), { status: { from: 'open', to: 'done' }, labels: { from: ['ui'], to: ['bug', 'ui'] } });
  assert.deepEqual(diffOf('task', before, before), {});
  assert.deepEqual(diffOf('task', null, after), {});
});

test('a request mutation records the caller, request id and diff', () => {
  const { db, user } = world();
  const context = requestContext({ user, apiKeyId: 'k-1', ip: '10.0.0.1', requestId: 'req-1' });
  withAuditContext(context, () => audited(db, 1000, { type: 'user', id: 'u-1' }, 'update', () => rename(db, 'Ana B')));
  const [entry] = entries(db);
  assert.equal(entry.actor_type, 'user');
  assert.equal(entry.actor_id, 'u-1');
  assert.equal(entry.request_id, 'req-1');
  assert.equal(entry.ip, '10.0.0.1');
  assert.deepEqual(JSON.parse(entry.diff), { name: { from: 'Ana', to: 'Ana B' } });
});

test('outside a request the actor is the system', () => {
  const { db } = world();
  auditCreated(db, 1000, { type: 'user', id: 'u-1' }, 'send');
  const [entry] = entries(db);
  assert.equal(entry.actor_type, 'system');
  assert.equal(entry.before, null);
});

test('an entry rolls back with its mutation', () => {
  const { db } = world();
  assert.throws(() =>
    immediate(db, () => {
      audited(db, 1000, { type: 'user', id: 'u-1' }, 'update', () => rename(db, 'Gone'));
      throw new Error('rejected');
    }),
  );
  assert.deepEqual(entries(db), []);
});
