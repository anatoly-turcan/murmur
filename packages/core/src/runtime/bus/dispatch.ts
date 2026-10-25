import type { RunContext } from '../../model/context.ts';
import type { Delivery } from '../../model/delivery.ts';
import { isInternal } from '../../model/names.ts';
import { parseWire } from '../../model/schema.ts';
import { HandlerTimeoutError, NoHandlerError, ShutdownError } from '../errors.ts';
import type { DeliveryHandler, TransportDelivery } from '../transport.ts';
import {
  armTimeout,
  closeEmits,
  durationMs,
  enrolScope,
  nextDeliveryId,
  race,
  report,
  runDeadline,
  serialize,
  type RunJob,
} from './job.ts';
import { backoff } from './policy.ts';
import {
  handlerKind,
  noteIgnoredReply,
  replyFailure,
  replyWith,
  wantsReply,
  type ReplyTarget,
} from './reply.ts';
import { acquireSlot, releaseSlot, sinkLine, type BusState, type PieceEntry } from './state.ts';
import type { PieceHandlerEntry } from './types.ts';

type FailurePhase = 'handler' | 'emit' | 'reply';
type TerminalPhase = FailurePhase | 'validate' | 'no-handler';
type FailureReason = 'requester-gone';
type Outcome =
  | { readonly ok: true; readonly replied: boolean }
  | { readonly ok: false; readonly error: unknown; readonly phase: FailurePhase };

interface Job extends ReplyTarget, RunJob {}

interface RetryPlan {
  readonly willRetry: boolean;
  readonly delayMs: number;
  readonly reason: FailureReason | undefined;
}

function requestOf(delivery: TransportDelivery): Pick<RunContext, 'request'> {
  const { correlationId, replyTo } = delivery.envelope;
  if (correlationId === undefined || replyTo === undefined) {
    return {};
  }

  const replyAddress = delivery.replyAddress;

  return { request: { correlationId, replyTo, ...(replyAddress === undefined ? {} : { replyAddress }) } };
}

function buildRun(
  state: BusState,
  piece: PieceEntry,
  delivery: TransportDelivery,
  signal: AbortSignal,
  deliveryId: string,
): RunContext {
  const { envelope } = delivery;

  return {
    traceId: envelope.traceId,
    eventId: envelope.id,
    hop: envelope.hop,
    piece: piece.name,
    deliveryId,
    attempt: delivery.attempt,
    signal,
    deadline: runDeadline(state, piece),
    internal: isInternal(envelope.name),
    ...requestOf(delivery),
  };
}

function createJob(state: BusState, piece: PieceEntry, delivery: TransportDelivery): Job {
  const ctrl = new AbortController();
  const deliveryId = nextDeliveryId(state);
  const job: Job = {
    state,
    piece,
    delivery,
    envelope: delivery.envelope,
    run: buildRun(state, piece, delivery, ctrl.signal, deliveryId),
    ctrl,
    deliveryId,
    startedAt: performance.now(),
    emits: [],
    settled: false,
  };
  enrolScope(job);

  return job;
}

function ref(job: Job): { deliveryId: string; envelopeId: string; name: string; piece: string } {
  return {
    deliveryId: job.deliveryId,
    envelopeId: job.envelope.id,
    name: job.envelope.name,
    piece: job.piece.name,
  };
}

function isRetryable(error: unknown): boolean {
  return !(typeof error === 'object' && error !== null && Reflect.get(error, 'retryable') === false);
}

function deliveryOf(job: Job): Delivery {
  return Object.freeze({
    envelope: job.envelope,
    attempt: job.delivery.attempt,
    signal: job.run.signal,
    piece: job.piece.name,
  });
}

function callHandler(job: Job, entry: PieceHandlerEntry, value: unknown): Promise<unknown> {
  return Promise.try(() => entry.handle(value, deliveryOf(job)));
}

async function execute(job: Job, entry: PieceHandlerEntry, value: unknown): Promise<Outcome> {
  let result: unknown;

  try {
    result = await race(job, callHandler(job, entry, value));
  } catch (error) {
    job.settled = true;

    return { ok: false, error, phase: 'handler' };
  }

  try {
    await closeEmits(job);
  } catch (error) {
    job.settled = true;

    return { ok: false, error, phase: 'emit' };
  }

  if (!wantsReply(job, entry.contract)) {
    if (handlerKind(entry.contract) === 'listener') {
      noteIgnoredReply(job, entry.contract, result);
    }

    return { ok: true, replied: false };
  }

  try {
    await replyWith(job, entry.contract, result);
  } catch (error) {
    return { ok: false, error, phase: 'reply' };
  }

  return { ok: true, replied: true };
}

async function acknowledge(job: Job, replied: boolean): Promise<void> {
  job.settled = true;
  await job.delivery.ack();
  report(job, 'delivery.acked', {
    ...ref(job),
    attempt: job.delivery.attempt,
    durationMs: durationMs(job),
    replied,
  });
}

async function dropInternal(job: Job, error: unknown, phase: TerminalPhase): Promise<void> {
  sinkLine(job.state, {
    level: 'error',
    piece: job.piece.name,
    msg: `internal delivery ${job.envelope.name} dropped (${phase})`,
    traceId: job.run.traceId,
    error: serialize(job, error),
  });
  job.settled = true;
  await job.delivery.ack();
}

function reasonField(reason: FailureReason | undefined): { reason?: FailureReason } {
  if (reason === undefined) {
    return {};
  }

  return { reason };
}

async function sendFailureReply(job: Job, error: unknown): Promise<void> {
  await replyFailure(job, error).catch((replyError: unknown) => {
    sinkLine(job.state, {
      level: 'error',
      piece: job.piece.name,
      msg: 'failure reply not sent',
      traceId: job.run.traceId,
      error: serialize(job, replyError),
    });
  });
}

async function deadLetter(
  job: Job,
  error: unknown,
  phase: TerminalPhase,
  reason?: FailureReason,
): Promise<void> {
  if (job.run.internal) {
    return dropInternal(job, error, phase);
  }

  report(job, 'delivery.deadlettered', {
    deliveryId: job.deliveryId,
    envelope: job.envelope,
    piece: job.piece.name,
    attempts: job.delivery.attempt,
    error: serialize(job, error),
    phase,
    ...reasonField(reason),
  });

  if (job.envelope.replyTo !== undefined) {
    await sendFailureReply(job, error);
  }

  job.settled = true;
  await job.delivery.nack(false);
}

async function retry(job: Job, delayMs: number): Promise<void> {
  const { attempt } = job.delivery;
  report(job, 'delivery.retried', { ...ref(job), nextAttempt: attempt + 1, delayMs });
  job.settled = true;
  await job.delivery.nack(true, { delayMs });
}

async function requeueForShutdown(job: Job): Promise<void> {
  job.settled = true;
  await job.delivery.nack(true, { delayMs: 0, consumeAttempt: false });
}

function requesterGone(job: Job, delayMs: number): boolean {
  const { deadline, replyTo } = job.envelope;
  if (replyTo === undefined || deadline === undefined) {
    return false;
  }

  const nextAttemptAt = job.state.clock.now().add({ milliseconds: delayMs });

  return Temporal.Instant.compare(nextAttemptAt, Temporal.Instant.from(deadline)) >= 0;
}

function planRetry(job: Job, error: unknown): RetryPlan {
  const { attempt } = job.delivery;
  const allowed = isRetryable(error) && attempt < job.piece.policy.retry.maxAttempts;

  if (!allowed) {
    return { willRetry: false, delayMs: 0, reason: undefined };
  }

  const delayMs = backoff(job.piece.policy.retry, attempt);
  if (requesterGone(job, delayMs)) {
    return { willRetry: false, delayMs, reason: 'requester-gone' };
  }

  return { willRetry: true, delayMs, reason: undefined };
}

async function fail(job: Job, error: unknown, phase: FailurePhase): Promise<void> {
  if (job.run.internal) {
    return dropInternal(job, error, phase);
  }

  if (error instanceof ShutdownError) {
    return requeueForShutdown(job);
  }

  const { attempt } = job.delivery;
  if (error instanceof HandlerTimeoutError && error === job.ctrl.signal.reason) {
    report(job, 'delivery.timeout', { ...ref(job), attempt, timeoutMs: error.timeoutMs });
  }

  const plan = planRetry(job, error);
  report(job, 'delivery.failed', {
    ...ref(job),
    attempt,
    durationMs: durationMs(job),
    error: serialize(job, error),
    willRetry: plan.willRetry,
    phase,
    ...reasonField(plan.reason),
  });

  if (plan.willRetry) {
    return retry(job, plan.delayMs);
  }

  return deadLetter(job, error, phase, plan.reason);
}

async function validated(
  job: Job,
  entry: PieceHandlerEntry,
): Promise<{ readonly value: unknown } | undefined> {
  try {
    return {
      value: await parseWire(entry.contract.name, 'payload', entry.contract.payload, job.envelope.payload),
    };
  } catch (error) {
    await deadLetter(job, error, 'validate');

    return undefined;
  }
}

function announceReceived(job: Job): void {
  report(job, 'delivery.received', {
    ...ref(job),
    attempt: job.delivery.attempt,
    redelivered: job.delivery.redelivered,
    traceId: job.envelope.traceId,
    deadline: job.run.deadline,
  });
}

async function process(job: Job): Promise<void> {
  const entry = job.piece.byName.get(job.envelope.name);
  if (entry === undefined) {
    return deadLetter(job, new NoHandlerError(job.piece.name, job.envelope.name), 'no-handler');
  }

  const payload = await validated(job, entry);
  if (payload === undefined) {
    return;
  }

  announceReceived(job);
  const outcome = await execute(job, entry, payload.value);
  if (outcome.ok) {
    return acknowledge(job, outcome.replied);
  }

  return fail(job, outcome.error, outcome.phase);
}

async function runJob(job: Job): Promise<void> {
  const timer = armTimeout(job, job.envelope.name);

  try {
    await process(job);
  } catch (error) {
    sinkLine(job.state, {
      level: 'error',
      piece: job.piece.name,
      msg: 'dispatch failed',
      traceId: job.run.traceId,
      error: serialize(job, error),
    });
    await job.delivery.nack(true).catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}

function track(state: BusState, piece: PieceEntry, delivery: TransportDelivery): Promise<void> {
  const job = createJob(state, piece, delivery);
  const done = state.context.run(job.run, () => runJob(job));
  state.inflight.set(job.ctrl, done);

  return done.finally(() => state.inflight.delete(job.ctrl));
}

async function admit(state: BusState, piece: PieceEntry, delivery: TransportDelivery): Promise<void> {
  const queued = acquireSlot(piece);
  if (queued === undefined) {
    return track(state, piece, delivery);
  }

  await queued;

  if (state.stopping.signal.aborted) {
    return delivery.nack(true, { delayMs: 0, consumeAttempt: false });
  }

  return track(state, piece, delivery);
}

export function dispatcher(state: BusState, piece: PieceEntry): DeliveryHandler {
  return (delivery) => admit(state, piece, delivery).finally(() => releaseSlot(piece));
}
