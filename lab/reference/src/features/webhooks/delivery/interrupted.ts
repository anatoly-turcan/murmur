import type { DatabaseSync } from 'node:sqlite';
import { jobPayload, type JobOutcome, type JobRow } from '../../../jobs/types.ts';
import { hasOpenAttempt, settlingOutcome } from './outcome.ts';
import type { Id } from '../../../ids/uuid.ts';

export const WORKER_TERMINATED = 'worker terminated';

export function interruptedDelivery(db: DatabaseSync, job: JobRow, now: number): JobOutcome {
  const { delivery_id: deliveryId } = jobPayload<{ delivery_id: Id }>(job);
  if (!hasOpenAttempt(db, deliveryId)) return { result: { status: 'retry', runAt: now, error: WORKER_TERMINATED } };

  return settlingOutcome(db, deliveryId, { outcome: 'error', statusCode: null, error: WORKER_TERMINATED }, now);
}
