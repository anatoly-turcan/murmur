import { isOwned } from '../../../jobs/claim.ts';
import { jobPayload, succeeded, type JobContext, type JobHandler, type JobRow } from '../../../jobs/types.ts';
import { sendAttempt, type AttemptRequest } from './attempt.ts';
import { interruptedDelivery } from './interrupted.ts';
import { openAttempt, settlingOutcome, type OpenedAttempt } from './outcome.ts';
import type { Id } from '../../../ids/uuid.ts';

function requestFor(opened: OpenedAttempt, timeoutMs: number): AttemptRequest {
  return {
    url: opened.webhook.url,
    secret: opened.webhook.secret,
    payload: opened.delivery.payload,
    event: opened.delivery.event,
    deliveryId: opened.delivery.id,
    number: opened.number,
    startedAt: opened.startedAt,
    timeoutMs,
  };
}

function open(job: JobRow, ctx: JobContext, deliveryId: Id): OpenedAttempt | null {
  return ctx.begin(() => (isOwned(ctx.db, job.id, ctx.workerId) ? openAttempt(ctx.db, deliveryId, ctx.now()) : null));
}

export const webhookDeliveryJob: JobHandler = {
  async run(job, ctx) {
    const { delivery_id: deliveryId } = jobPayload<{ delivery_id: Id }>(job);
    const opened = open(job, ctx, deliveryId);
    if (!opened) return succeeded();
    const result = await sendAttempt(requestFor(opened, ctx.config.webhookTimeoutMs));

    return settlingOutcome(ctx.db, deliveryId, result, ctx.now());
  },
  onInterrupted: interruptedDelivery,
};
