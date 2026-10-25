import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.ts';
import { claimNext, countDue } from '../src/jobs/claim.ts';
import { applyResult, enqueue, genericFailure } from '../src/jobs/queue.ts';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  return db;
}

test('serial queue jobs run one at a time in order', () => {
  const db = freshDb();
  const a = enqueue(db, { type: 'webhook_delivery', runAt: 0, now: 0, queueKey: 'webhook:1' });
  enqueue(db, { type: 'webhook_delivery', runAt: 0, now: 0, queueKey: 'webhook:1' });
  const first = claimNext(db, 'w1', 1, ['webhook_delivery']);
  assert.equal(first?.id, a.id);
  assert.equal(claimNext(db, 'w2', 1, ['webhook_delivery']), null);
  applyResult(db, first!, genericFailure(1, 1, 'boom'), 1);
  assert.equal(claimNext(db, 'w2', 5_000, ['webhook_delivery']), null);
  assert.deepEqual(countDue(db, 20_000), { pending: 1, running: 0, dead: 0 });
  assert.equal(claimNext(db, 'w2', 20_000, ['webhook_delivery'])?.id, a.id);
});

test('claim only takes registered job types', () => {
  const db = freshDb();
  enqueue(db, { type: 'digest', runAt: 0, now: 0 });
  assert.equal(claimNext(db, 'w1', 1, ['email']), null);
  assert.notEqual(claimNext(db, 'w1', 1, ['digest']), null);
});

test('generic retry schedule ends dead after the fifth failure', () => {
  assert.deepEqual(genericFailure(1, 0, 'e'), { status: 'retry', runAt: 10_000, error: 'e' });
  assert.deepEqual(genericFailure(4, 0, 'e'), { status: 'retry', runAt: 1_800_000, error: 'e' });
  assert.deepEqual(genericFailure(5, 0, 'e'), { status: 'dead', error: 'e' });
});
