import type { RunContext } from '../../model/context.ts';
import type { Envelope } from '../../model/envelope.ts';
import {
  ContractViolationError,
  NotRequestableError,
  serializeError,
  type SerializedError,
} from '../../model/errors.ts';
import type { RequestOptions } from '../../model/policy.ts';
import { parseWire } from '../../model/schema.ts';
import { CascadeDepthError, RemoteError, RequestTimeoutError, ShutdownError } from '../errors.ts';
import type { TransportDelivery, Subscription } from '../transport.ts';
import { onAnyAbort, raceAbort } from './abort.ts';
import type { BusContract } from './contracts.ts';
import {
  abandonUnfollowed,
  announceDeduped,
  coversRemainingTime,
  isDedupable,
  leaderOf,
  queryKey,
  rememberLeader,
  type RunOrigin,
} from './dedupe.ts';
import { dispatcher } from './dispatch.ts';
import { deliverLocally, localResponder } from './local.ts';
import { buildEnvelope, publishEnvelope, publishLocally, type Origin } from './publish.ts';
import type { BusState, PendingRequest, PieceEntry } from './state.ts';

const FINISHED_LIMIT = 1_024;
const REPLY_PREFETCH = 64;

type ReplyPayload = { ok: true; value: unknown } | { ok: false; error: SerializedError };
type Settled =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

function remember(state: BusState, correlationId: string, name: string, replied: boolean): void {
  const { finished } = state.requests;
  finished.set(correlationId, { name, replied });

  if (finished.size > FINISHED_LIMIT) {
    finished.delete(finished.keys().next().value ?? '');
  }
}

function take(state: BusState, correlationId: string): PendingRequest | undefined {
  const pending = state.requests.pending.get(correlationId);
  if (pending === undefined) {
    return undefined;
  }

  state.requests.pending.delete(correlationId);
  pending.release();

  return pending;
}

function elapsed(pending: PendingRequest): number {
  return Math.round(performance.now() - pending.startedAt);
}

function expire(state: BusState, correlationId: string, timeoutMs: number): void {
  const pending = take(state, correlationId);
  if (pending === undefined) {
    return;
  }

  remember(state, correlationId, pending.contract.name, false);
  pending.reject(new RequestTimeoutError(pending.contract.name, correlationId, elapsed(pending)));
  state.sys(
    'request.timeout',
    { correlationId, name: pending.contract.name, piece: pending.piece, timeoutMs },
    { traceId: pending.traceId, hop: pending.hop, source: pending.piece },
  );
}

interface Prepared {
  readonly contract: BusContract;
  readonly envelope: Envelope & { correlationId: string };
  readonly timeoutMs: number;
}

function awaitReply(
  state: BusState,
  prepared: Prepared,
  signals: readonly (AbortSignal | undefined)[],
  counter: { deduped: number } | undefined,
): Promise<unknown> {
  const { contract, envelope, timeoutMs } = prepared;
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const done = Promise.withResolvers<void>();
  const { correlationId } = envelope;
  const timer = setTimeout(() => expire(state, correlationId, timeoutMs), timeoutMs);
  const removeListeners = onAnyAbort(signals, (reason) => {
    if (take(state, correlationId) !== undefined) {
      reject(reason);
    }
  });
  state.requests.pending.set(correlationId, {
    contract,
    correlationId,
    envelopeId: envelope.id,
    traceId: envelope.traceId,
    hop: envelope.hop,
    piece: envelope.source ?? 'external',
    startedAt: performance.now(),
    resolve,
    reject,
    release: () => {
      clearTimeout(timer);
      removeListeners();
      done.resolve();
    },
    done: done.promise,
    counter,
  });

  return promise;
}

function replyRun(state: BusState, pending: PendingRequest): RunContext {
  return {
    traceId: pending.traceId,
    eventId: pending.envelopeId,
    hop: pending.hop,
    piece: pending.piece,
    signal: state.stopping.signal,
    internal: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWireError(value: unknown): value is SerializedError {
  return isRecord(value) && typeof value['name'] === 'string' && typeof value['message'] === 'string';
}

function isReplyPayload(value: unknown): value is ReplyPayload {
  if (!isRecord(value)) {
    return false;
  }

  if (value['ok'] === true) {
    return 'value' in value;
  }

  return value['ok'] === false && isWireError(value['error']);
}

async function outcomeOf(contract: BusContract, payload: unknown): Promise<Settled> {
  if (!isReplyPayload(payload)) {
    return {
      ok: false,
      error: new ContractViolationError(contract.name, 'reply', [{ message: 'malformed reply envelope' }]),
    };
  }

  if (!payload.ok) {
    return { ok: false, error: new RemoteError(contract.name, payload.error) };
  }

  try {
    return {
      ok: true,
      value: await parseWire(contract.name, 'reply', contract.reply ?? contract.payload, payload.value),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

function dedupedField(pending: PendingRequest): { deduped?: number } {
  if (pending.counter === undefined) {
    return {};
  }

  return { deduped: pending.counter.deduped };
}

async function settleReply(state: BusState, pending: PendingRequest, payload: unknown): Promise<void> {
  const { contract, correlationId } = pending;
  const settled = await outcomeOf(contract, payload);

  if (settled.ok) {
    pending.resolve(settled.value);
  } else {
    pending.reject(settled.error);
  }

  state.sys(
    'request.completed',
    {
      correlationId,
      name: contract.name,
      piece: pending.piece,
      durationMs: elapsed(pending),
      ok: settled.ok,
      error: settled.ok ? undefined : serializeError(settled.error, state.mode === 'dev'),
      ...dedupedField(pending),
    },
    { traceId: pending.traceId, hop: pending.hop, source: pending.piece },
  );
}

function reportStray(state: BusState, correlationId: string): void {
  const finished = state.requests.finished.get(correlationId);
  const name = finished?.name ?? 'unknown';
  state.sys(finished?.replied === true ? 'request.duplicate-reply' : 'request.late-reply', {
    correlationId,
    name,
  });
}

async function settleEnvelope(state: BusState, reply: Envelope): Promise<void> {
  const correlationId = reply.correlationId ?? '';
  const pending = take(state, correlationId);

  if (pending === undefined) {
    return reportStray(state, correlationId);
  }

  remember(state, correlationId, pending.contract.name, true);

  await state.context.run(replyRun(state, pending), () => settleReply(state, pending, reply.payload));
}

async function onReply(state: BusState, delivery: TransportDelivery): Promise<void> {
  await delivery.ack();
  state.requests.inbound.delete(delivery.envelope.correlationId ?? '');
  await settleEnvelope(state, delivery.envelope);
}

function ensureReplySubscription(state: BusState): Promise<Subscription> {
  const existing = state.requests.subscription;
  if (existing !== undefined) {
    return existing;
  }

  const created = state.transport.subscribe([state.replyTo], state.replyTo, (d) => onReply(state, d), {
    prefetch: REPLY_PREFETCH,
    exclusive: true,
  });
  state.requests.subscription = created;
  created.catch(() => {
    state.requests.subscription = undefined;
  });

  return created;
}

function assertRequestable(state: BusState, contract: BusContract, origin: Origin): void {
  if (contract.reply === undefined) {
    throw new NotRequestableError(contract.name);
  }

  if (state.requests.closed) {
    throw new ShutdownError(`${contract.name}: the bus is stopping`);
  }

  const hop = (origin.parent?.hop ?? -1) + 1;
  if (hop > state.limits.maxHop) {
    throw new CascadeDepthError(contract.name, hop, state.limits.maxHop);
  }
}

function prepare(
  state: BusState,
  contract: BusContract,
  value: unknown,
  origin: Origin,
  timeoutMs: number,
): Prepared {
  const correlationId = state.ids.uuid();
  const envelope = buildEnvelope(state, contract.name, value, origin, {
    correlationId,
    replyTo: state.replyTo,
  });
  const deadline = Temporal.Instant.from(envelope.ts).add({ milliseconds: timeoutMs }).toString();

  return { contract, envelope: { ...envelope, correlationId, deadline }, timeoutMs };
}

function announceSent(state: BusState, prepared: Prepared): void {
  const { envelope, contract, timeoutMs } = prepared;
  state.sys(
    'request.sent',
    {
      correlationId: envelope.correlationId,
      envelopeId: envelope.id,
      name: contract.name,
      piece: envelope.source ?? 'external',
      traceId: envelope.traceId,
      timeoutMs,
    },
    { traceId: envelope.traceId, hop: envelope.hop, source: envelope.source },
  );
}

function issueLocally(state: BusState, prepared: Prepared, origin: Origin, piece: PieceEntry): void {
  publishLocally(state, prepared.envelope, origin.late);
  announceSent(state, prepared);
  deliverLocally({
    state,
    dispatch: dispatcher(state, piece),
    envelope: prepared.envelope,
    settleReply: (reply) => settleEnvelope(state, reply),
  });
}

async function send(
  state: BusState,
  prepared: Prepared,
  origin: Origin,
  local: PieceEntry | undefined,
): Promise<void> {
  if (local !== undefined) {
    return issueLocally(state, prepared, origin, local);
  }

  await publishEnvelope(state, prepared.envelope, { mandatory: true }, origin.late);
  announceSent(state, prepared);
}

async function issue(
  state: BusState,
  prepared: Prepared,
  origin: Origin,
  signals: readonly (AbortSignal | undefined)[],
  counter?: { deduped: number },
): Promise<unknown> {
  const local = localResponder(state, prepared.contract.name);
  if (local === undefined) {
    await ensureReplySubscription(state);
  }

  for (const signal of signals) {
    signal?.throwIfAborted();
  }

  const reply = awaitReply(state, prepared, signals, counter);

  try {
    await send(state, prepared, origin, local);
  } catch (error) {
    take(state, prepared.envelope.correlationId);
    throw error;
  }

  return reply;
}

function lead(
  state: BusState,
  contract: BusContract,
  value: unknown,
  origin: RunOrigin,
  timeoutMs: number,
  key: string,
): Promise<unknown> {
  const prepared = prepare(state, contract, value, origin, timeoutMs);
  const counter = { deduped: 0 };
  const abandon = new AbortController();
  const promise = issue(state, prepared, origin, [abandon.signal], counter);
  promise.catch(() => {});
  const leader = {
    promise,
    expiresAt: performance.now() + timeoutMs,
    envelopeId: prepared.envelope.id,
    counter,
  };
  rememberLeader(state, origin.parent.traceId, key, leader);
  abandonUnfollowed(state, { traceId: origin.parent.traceId, key, leader }, origin.parent.signal, abandon);

  return raceAbort(promise, origin.parent.signal);
}

function dedupedRequest(
  state: BusState,
  contract: BusContract,
  value: unknown,
  origin: RunOrigin,
  timeoutMs: number,
): Promise<unknown> {
  const key = queryKey(contract.name, value);
  const leader = leaderOf(state, origin.parent.traceId, key);

  if (leader === undefined) {
    return lead(state, contract, value, origin, timeoutMs, key);
  }

  if (!coversRemainingTime(leader, timeoutMs)) {
    return issue(state, prepare(state, contract, value, origin, timeoutMs), origin, [origin.parent.signal]);
  }

  announceDeduped(state, leader, key, origin);

  return raceAbort(leader.promise, origin.parent.signal);
}

export async function sendRequest(
  state: BusState,
  contract: BusContract,
  payload: unknown,
  origin: Origin,
  options: RequestOptions = {},
): Promise<unknown> {
  assertRequestable(state, contract, origin);
  const value = await parseWire(contract.name, 'payload', contract.payload, payload);
  const timeoutMs = options.timeoutMs ?? state.policy.requestTimeoutMs;

  if (isDedupable(contract, origin, options)) {
    return dedupedRequest(state, contract, value, origin, timeoutMs);
  }

  const prepared = prepare(state, contract, value, origin, timeoutMs);

  return issue(state, prepared, origin, [options.signal, origin.parent?.signal]);
}

export function answeredLocally(state: BusState): Promise<void>[] {
  const { pending, inbound } = state.requests;

  return [...pending.values()].filter((p) => inbound.has(p.correlationId)).map((p) => p.done);
}

export async function closeRequests(state: BusState, reason: string): Promise<void> {
  state.requests.closed = true;
  state.closing.abort(new ShutdownError(`request aborted: ${reason}`));
  state.requests.inbound.clear();

  for (const correlationId of state.requests.pending.keys()) {
    take(state, correlationId)?.reject(new ShutdownError(`request aborted: ${reason}`));
  }

  const subscription = await state.requests.subscription?.catch(() => undefined);
  await subscription?.unsubscribe();
}
