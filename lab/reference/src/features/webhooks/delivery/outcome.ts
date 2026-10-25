import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../../audit/record.ts';
import { insert, one, run } from '../../../db/sql.ts';
import type { DeliveryRow, WebhookRow } from '../../../domain/rows.ts';
import type { JobOutcome, JobResult } from '../../../jobs/types.ts';
import type { AttemptResult } from './attempt.ts';
import type { Id } from '../../../ids/uuid.ts';

export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
const ATTEMPTS_PER_SERIES = RETRY_DELAYS_MS.length + 1;

export interface OpenedAttempt {
  delivery: DeliveryRow;
  webhook: WebhookRow;
  number: number;
  startedAt: number;
}

function loadDelivery(db: DatabaseSync, deliveryId: Id): DeliveryRow | undefined {
  return one<DeliveryRow>(db, 'SELECT * FROM webhook_deliveries WHERE id = ?', deliveryId);
}

function isOpen(delivery: DeliveryRow): boolean {
  return delivery.status === 'pending' || delivery.status === 'in_progress';
}

export function openAttempt(db: DatabaseSync, deliveryId: Id, now: number): OpenedAttempt | null {
  const delivery = loadDelivery(db, deliveryId);
  if (!delivery || !isOpen(delivery)) return null;
  const webhook = one<WebhookRow>(db, 'SELECT * FROM webhook_endpoints WHERE id = ?', delivery.webhook_id);
  if (!webhook) return null;
  const number = delivery.attempt_count + 1;
  insert(db, 'INSERT INTO webhook_attempts (delivery_id, number, started_at) VALUES (?, ?, ?)', deliveryId, number, now);
  run(
    db,
    `UPDATE webhook_deliveries SET status = 'in_progress', attempt_count = ?, next_attempt_at = NULL WHERE id = ?`,
    number,
    deliveryId,
  );

  return { delivery, webhook, number, startedAt: now };
}

export function hasOpenAttempt(db: DatabaseSync, deliveryId: Id): boolean {
  return one(db, 'SELECT 1 AS x FROM webhook_attempts WHERE delivery_id = ? AND finished_at IS NULL', deliveryId) !== undefined;
}

function closeAttempt(db: DatabaseSync, deliveryId: Id, result: AttemptResult, finishedAt: number): void {
  run(
    db,
    `UPDATE webhook_attempts SET finished_at = max(started_at, ?), outcome = ?, status_code = ?, error = ?
      WHERE delivery_id = ? AND finished_at IS NULL`,
    finishedAt,
    result.outcome,
    result.statusCode,
    result.error,
    deliveryId,
  );
}

function succeed(db: DatabaseSync, deliveryId: Id, finishedAt: number): JobResult {
  run(db, `UPDATE webhook_deliveries SET status = 'succeeded', completed_at = ?, next_attempt_at = NULL WHERE id = ?`, finishedAt, deliveryId);

  return { status: 'succeeded' };
}

function die(db: DatabaseSync, deliveryId: Id, failures: number, finishedAt: number, error: string): JobResult {
  run(
    db,
    `UPDATE webhook_deliveries SET status = 'dead', series_failures = ?, completed_at = ?, next_attempt_at = NULL WHERE id = ?`,
    failures,
    finishedAt,
    deliveryId,
  );

  return { status: 'dead', error };
}

function scheduleRetry(db: DatabaseSync, deliveryId: Id, failures: number, finishedAt: number, error: string): JobResult {
  const runAt = finishedAt + RETRY_DELAYS_MS[failures - 1];
  run(
    db,
    `UPDATE webhook_deliveries SET status = 'pending', series_failures = ?, next_attempt_at = ? WHERE id = ?`,
    failures,
    runAt,
    deliveryId,
  );

  return { status: 'retry', runAt, error };
}

function failureText(result: AttemptResult): string {
  return result.statusCode !== null ? `${result.outcome} (${result.statusCode})` : `${result.outcome}: ${result.error}`;
}

function settleDelivery(db: DatabaseSync, deliveryId: Id, result: AttemptResult, finishedAt: number): JobResult {
  const delivery = loadDelivery(db, deliveryId);
  if (delivery?.status !== 'in_progress') return { status: 'succeeded' };
  if (result.outcome === 'success') return succeed(db, deliveryId, finishedAt);
  const failures = delivery.series_failures + 1;
  const error = failureText(result);
  if (failures >= ATTEMPTS_PER_SERIES) return die(db, deliveryId, failures, finishedAt, error);

  return scheduleRetry(db, deliveryId, failures, finishedAt, error);
}

export function settlingOutcome(db: DatabaseSync, deliveryId: Id, result: AttemptResult, finishedAt: number): JobOutcome {
  const outcome: JobOutcome = { result: { status: 'succeeded' } };
  // The runner reads outcome.result only after apply(), so the transition seen inside the commit decides it.
  outcome.apply = () => {
    audited(db, finishedAt, { type: 'delivery', id: deliveryId }, 'deliver', () => {
      closeAttempt(db, deliveryId, result, finishedAt);
      outcome.result = settleDelivery(db, deliveryId, result, finishedAt);
    });
  };

  return outcome;
}
