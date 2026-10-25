import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.ts';
import { one, run } from '../src/db/sql.ts';
import type { AttemptRow, DeliveryRow } from '../src/domain/rows.ts';
import { signature, type AttemptResult } from '../src/features/webhooks/delivery/attempt.ts';
import { interruptedDelivery } from '../src/features/webhooks/delivery/interrupted.ts';
import { openAttempt, RETRY_DELAYS_MS, settlingOutcome } from '../src/features/webhooks/delivery/outcome.ts';
import { enqueue } from '../src/jobs/queue.ts';
import type { JobRow } from '../src/jobs/types.ts';

const FAILURE: AttemptResult = { outcome: 'failure', statusCode: 500, error: null };

function deliveryWorld(): { db: DatabaseSync; deliveryId: string; job: JobRow } {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.exec('PRAGMA foreign_keys = OFF');
  const hookId = 'hook-1';
  run(
    db,
    `INSERT INTO webhook_endpoints (id, workspace_id, url, events, secret, created_at, updated_at) VALUES (?, 'ws-1', 'http://127.0.0.1:9/x', '["*"]', 's', 0, 0)`,
    hookId,
  );
  const ref = enqueue(db, { type: 'webhook_delivery', runAt: 0, now: 0, queueKey: `webhook:${hookId}` });
  const deliveryId = 'delivery-1';
  run(
    db,
    `INSERT INTO webhook_deliveries (id, webhook_id, workspace_id, activity_event_id, event, payload, status, job_id, created_at)
     VALUES (?, ?, 'ws-1', 'event-1', 'task.created', '{}', 'pending', ?, 0)`,
    deliveryId,
    hookId,
    ref.id,
  );
  const job = one<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', ref.id)!;

  return { db, deliveryId, job: { ...job, payload: JSON.stringify({ delivery_id: deliveryId }) } };
}

function attemptOnce(db: DatabaseSync, deliveryId: string, at: number, result: AttemptResult) {
  openAttempt(db, deliveryId, at);
  const outcome = settlingOutcome(db, deliveryId, result, at);
  outcome.apply?.();

  return outcome.result;
}

test('signature is the hex HMAC-SHA256 of "<timestamp>.<body>"', () => {
  const expected = createHmac('sha256', 'secret').update('1773151230.{"a":1}').digest('hex');
  assert.equal(signature('secret', 1773151230, '{"a":1}'), expected);
});

test('six failed attempts follow the 8.3 schedule and end dead', () => {
  const { db, deliveryId } = deliveryWorld();
  let at = 1_000;
  for (const delay of RETRY_DELAYS_MS) {
    assert.deepEqual(attemptOnce(db, deliveryId, at, FAILURE), { status: 'retry', runAt: at + delay, error: 'failure (500)' });
    at += delay;
  }
  assert.equal(attemptOnce(db, deliveryId, at, FAILURE).status, 'dead');
  const delivery = one<DeliveryRow>(db, 'SELECT * FROM webhook_deliveries WHERE id = ?', deliveryId)!;
  assert.deepEqual([delivery.status, delivery.attempt_count, delivery.completed_at, delivery.next_attempt_at], ['dead', 6, at, null]);
});

test('an interrupted attempt is closed as "worker terminated" and retried 30 s after detection', () => {
  const { db, deliveryId, job } = deliveryWorld();
  openAttempt(db, deliveryId, 1_000);
  const outcome = interruptedDelivery(db, job, 5_000);
  outcome.apply?.();
  assert.deepEqual(outcome.result, { status: 'retry', runAt: 35_000, error: 'error: worker terminated' });
  const attempt = one<AttemptRow>(db, 'SELECT * FROM webhook_attempts WHERE delivery_id = ?', deliveryId)!;
  assert.deepEqual([attempt.outcome, attempt.error, attempt.finished_at], ['error', 'worker terminated', 5_000]);
});

test('a delivery cancelled while in flight keeps its attempt and stays cancelled', () => {
  const { db, deliveryId } = deliveryWorld();
  openAttempt(db, deliveryId, 1_000);
  db.prepare(`UPDATE webhook_deliveries SET status = 'cancelled' WHERE id = ?`).run(deliveryId);
  const outcome = settlingOutcome(db, deliveryId, FAILURE, 2_000);
  outcome.apply?.();
  assert.deepEqual(outcome.result, { status: 'succeeded' });
  assert.equal(one<DeliveryRow>(db, 'SELECT * FROM webhook_deliveries WHERE id = ?', deliveryId)!.status, 'cancelled');
  assert.equal(one<AttemptRow>(db, 'SELECT * FROM webhook_attempts WHERE delivery_id = ?', deliveryId)!.outcome, 'failure');
});
