import type { RunContext } from '../../model/context.ts';
import type { Envelope } from '../../model/envelope.ts';
import { serializeError } from '../../model/errors.ts';
import { parseWire } from '../../model/schema.ts';
import type { TransportDelivery, PublishOptions } from '../transport.ts';
import type { BusContract } from './contracts.ts';
import { isLocalDelivery } from './local.ts';
import { buildEnvelope, publishEnvelope, publishLocally } from './publish.ts';
import type { BusState, PieceEntry } from './state.ts';

export type HandlerKind = 'responder' | 'listener';

export interface ReplyTarget {
  readonly state: BusState;
  readonly piece: PieceEntry;
  readonly delivery: TransportDelivery;
  readonly envelope: Envelope;
  readonly run: RunContext;
}

export function handlerKind(contract: BusContract): HandlerKind {
  return contract.reply === undefined ? 'listener' : 'responder';
}

export function wantsReply(target: ReplyTarget, contract: BusContract): boolean {
  return handlerKind(contract) === 'responder' && target.envelope.replyTo !== undefined;
}

function replyOptions(target: ReplyTarget): PublishOptions {
  const { replyAddress } = target.delivery;

  return {
    persistent: false,
    expiresMs: target.piece.policy.requestTimeoutMs,
    ...(replyAddress === undefined ? {} : { address: replyAddress }),
  };
}

async function publishReply(target: ReplyTarget, payload: unknown): Promise<void> {
  const { state, envelope, run } = target;
  if (envelope.replyTo === undefined || envelope.correlationId === undefined) {
    return;
  }

  const reply = buildEnvelope(
    state,
    envelope.replyTo,
    payload,
    { parent: run, source: target.piece.name },
    { correlationId: envelope.correlationId },
  );

  if (isLocalDelivery(target.delivery)) {
    publishLocally(state, reply);
    await target.delivery.settleReply(reply);

    return;
  }

  await publishEnvelope(state, reply, replyOptions(target));

  if (reply.name === state.replyTo) {
    state.requests.inbound.add(envelope.correlationId);
  }
}

export async function replyWith(target: ReplyTarget, contract: BusContract, result: unknown): Promise<void> {
  const value = await parseWire(contract.name, 'reply', contract.reply ?? contract.payload, result);
  await publishReply(target, { ok: true, value });
}

export async function replyFailure(target: ReplyTarget, error: unknown): Promise<void> {
  const serialized = serializeError(error, false);

  await publishReply(target, {
    ok: false,
    error: { ...serialized, retryable: serialized.retryable ?? false },
  });
}

export function noteIgnoredReply(target: ReplyTarget, contract: BusContract, result: unknown): void {
  const { state, piece } = target;
  if (result === undefined || state.mode !== 'dev' || piece.replyIgnored) {
    return;
  }

  piece.replyIgnored = true;
  state.sys(
    'delivery.reply-ignored',
    { piece: piece.name, name: contract.name },
    { traceId: target.run.traceId, hop: target.run.hop, source: piece.name },
  );
}
