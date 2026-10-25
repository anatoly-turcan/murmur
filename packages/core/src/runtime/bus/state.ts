import type { Clock, Ids } from '../../model/capabilities.ts';
import type { RunContext } from '../../model/context.ts';
import { MurmurError } from '../../model/errors.ts';
import type { SysName, SysPayloads } from '../../model/internal.ts';
import type { DeliveryPolicy } from '../../model/policy.ts';
import type { ContextStorage } from '../context.ts';
import type { Subscription, Transport } from '../transport.ts';
import type { BusContract } from './contracts.ts';
import type { BusStacks, LogLine, PieceHandlerEntry, PieceRuntime, Registration } from './types.ts';

export interface About {
  readonly traceId?: string | undefined;
  readonly hop?: number | undefined;
  readonly source?: string | undefined;
}

export type SysEmitter = <K extends SysName>(name: K, payload: SysPayloads[K], about?: About) => void;

export interface PendingRequest {
  readonly contract: BusContract;
  readonly correlationId: string;
  readonly envelopeId: string;
  readonly traceId: string;
  readonly hop: number;
  readonly piece: string;
  readonly startedAt: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly counter?: { deduped: number } | undefined;
}

export interface RequestState {
  readonly pending: Map<string, PendingRequest>;
  readonly finished: Map<string, { readonly name: string; readonly replied: boolean }>;
  readonly inbound: Set<string>;
  readonly queries: Map<string, Map<string, InFlightQuery>>;
  subscription: Promise<Subscription> | undefined;
  closed: boolean;
}

export interface PieceEntry {
  readonly runtime: PieceRuntime;
  readonly name: string;
  readonly policy: DeliveryPolicy;
  readonly byName: ReadonlyMap<string, PieceHandlerEntry>;
  readonly declared: ReadonlySet<string>;
  replyIgnored: boolean;
  active: number;
  readonly waiting: (() => void)[];
}

export function acquireSlot(piece: PieceEntry): Promise<void> | undefined {
  if (piece.active < piece.policy.concurrency) {
    piece.active += 1;

    return undefined;
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  piece.waiting.push(resolve);

  return promise;
}

export function releaseSlot(piece: PieceEntry): void {
  const next = piece.waiting.shift();
  if (next === undefined) {
    piece.active -= 1;

    return;
  }

  next();
}

export interface EmitScope {
  readonly state: BusState;
  readonly piece: PieceEntry;
  readonly run: RunContext;
  readonly emits: Promise<void>[];
  readonly isLate: () => boolean;
}

export interface InFlightQuery {
  readonly promise: Promise<unknown>;
  readonly expiresAt: number;
  readonly envelopeId: string;
  readonly counter: { deduped: number };
}

export interface Limits {
  readonly warnBytes: number;
  readonly maxBytes: number;
  readonly maxHop: number;
}

export interface BusState {
  readonly transport: Transport;
  readonly context: ContextStorage<RunContext>;
  readonly ids: Ids;
  readonly clock: Clock;
  readonly instanceId: string;
  readonly replyTo: string;
  readonly policy: DeliveryPolicy;
  readonly limits: Limits;
  readonly mode: 'dev' | 'prod';
  readonly payloads: boolean;
  readonly localRequests: boolean;
  readonly sink: (line: LogLine) => void;
  readonly stopping: AbortController;
  readonly closing: AbortController;
  readonly sys: SysEmitter;
  readonly inflight: Map<AbortController, Promise<void>>;
  readonly zombies: Set<Promise<unknown>>;
  readonly responders: Map<string, string>;
  readonly registrations: Registration[];
  readonly pieces: Map<string, PieceEntry>;
  readonly scopes: WeakMap<RunContext, EmitScope>;
  readonly subscriptions: AsyncDisposableStack;
  readonly stacks: BusStacks;
  readonly observers: Set<Subscription>;
  readonly requests: RequestState;
  readonly counters: { internalDropped: number; observerDropped: number; deliveries: number };
}

export function registeredPiece(state: BusState, name: string): PieceEntry {
  const piece = state.pieces.get(name);
  if (piece === undefined) {
    throw new MurmurError(`piece ${name} is not registered on this bus`, {
      code: 'piece-not-registered',
      retryable: false,
    });
  }

  return piece;
}

export function sinkLine(state: BusState, line: Omit<LogLine, 'ts'>): void {
  try {
    state.sink({ ts: state.clock.now().toString(), ...line });
  } catch {
    state.counters.internalDropped++;
  }
}

export function inSequence<T>(items: readonly T[], step: (item: T) => Promise<unknown>): Promise<void> {
  return items.reduce<Promise<void>>(
    (previous, item) => previous.then(() => step(item)).then(() => undefined),
    Promise.resolve(),
  );
}

export function aboutRun(run: RunContext): About {
  return { traceId: run.traceId, hop: Math.max(run.hop, 0), source: run.piece };
}
