import type { RunContext } from '../../model/context.ts';
import type { Envelope } from '../../model/envelope.ts';
import { EmitNotDeclaredError } from '../../model/errors.ts';
import { isInternal, isReply } from '../../model/names.ts';
import { parseWire } from '../../model/schema.ts';
import { createEnvelope, envelopeBytes, serializeEnvelope } from '../envelope.ts';
import { CascadeDepthError, NoRouteError, PayloadTooLargeError } from '../errors.ts';
import type { PublishOptions } from '../transport.ts';
import type { BusContract } from './contracts.ts';
import { sinkLine, type BusState } from './state.ts';

export interface Origin {
  readonly parent?: RunContext | undefined;
  readonly source?: string | undefined;
  readonly late?: boolean;
}

export interface RequestFields {
  readonly correlationId: string;
  readonly replyTo?: string;
}

export function assertDeclared(piece: string, declared: ReadonlySet<string>, contract: BusContract): void {
  if (!declared.has(contract.name)) {
    throw new EmitNotDeclaredError(piece, contract.name);
  }
}

export function buildEnvelope(
  state: BusState,
  name: string,
  payload: unknown,
  origin: Origin,
  fields?: RequestFields,
): Envelope {
  return createEnvelope({
    name,
    payload,
    ids: state.ids,
    clock: state.clock,
    ...(origin.parent === undefined ? {} : { parent: origin.parent }),
    ...(origin.source === undefined ? {} : { source: origin.source }),
    ...fields,
  });
}

function assertHop(state: BusState, envelope: Envelope): void {
  if (isReply(envelope.name) || envelope.hop <= state.limits.maxHop) {
    return;
  }

  throw new CascadeDepthError(envelope.name, envelope.hop, state.limits.maxHop);
}

function measure(state: BusState, envelope: Envelope): number {
  const bytes = envelopeBytes(serializeEnvelope(envelope));
  if (bytes >= state.limits.maxBytes) {
    throw new PayloadTooLargeError(envelope.name, bytes, state.limits.maxBytes);
  }

  if (bytes >= state.limits.warnBytes) {
    sinkLine(state, {
      level: 'warn',
      piece: envelope.source ?? 'bus',
      msg: `${envelope.name}: envelope is ${bytes} bytes`,
      traceId: envelope.traceId,
    });
  }

  return bytes;
}

function announce(state: BusState, envelope: Envelope, bytes: number, late: boolean, local = false): void {
  state.sys(
    'event.published',
    {
      envelopeId: envelope.id,
      name: envelope.name,
      traceId: envelope.traceId,
      causationId: envelope.causationId,
      correlationId: envelope.correlationId,
      hop: envelope.hop,
      source: envelope.source,
      bytes,
      late,
      ...(local ? { local } : {}),
      envelope: state.payloads ? envelope : undefined,
    },
    { traceId: envelope.traceId, hop: envelope.hop, source: envelope.source },
  );
}

export async function publishEnvelope(
  state: BusState,
  envelope: Envelope,
  options: PublishOptions = {},
  late = false,
): Promise<void> {
  assertHop(state, envelope);
  const bytes = measure(state, envelope);

  try {
    await state.transport.publish(envelope, options);
  } catch (error) {
    if (error instanceof NoRouteError) {
      state.sys(
        'event.unrouted',
        { envelopeId: envelope.id, name: envelope.name, source: envelope.source },
        { traceId: envelope.traceId, hop: envelope.hop, source: envelope.source },
      );
    }

    throw error;
  }

  if (!isInternal(envelope.name)) {
    announce(state, envelope, bytes, late);
  }
}

export function publishLocally(state: BusState, envelope: Envelope, late = false): void {
  assertHop(state, envelope);
  const bytes = measure(state, envelope);
  if (!isInternal(envelope.name)) {
    announce(state, envelope, bytes, late, true);
  }
}

export async function publishEvent(
  state: BusState,
  contract: BusContract,
  payload: unknown,
  origin: Origin,
): Promise<void> {
  const value = await parseWire(contract.name, 'payload', contract.payload, payload);
  await publishEnvelope(state, buildEnvelope(state, contract.name, value, origin), {}, origin.late);
}
