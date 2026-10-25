import type { RunContext } from '../../model/context.ts';
import type { RequestOptions } from '../../model/policy.ts';
import { onAnyAbort } from './abort.ts';
import { isQueryContract, type BusContract } from './contracts.ts';
import type { Origin } from './publish.ts';
import type { BusState, InFlightQuery } from './state.ts';

export interface RunOrigin extends Origin {
  readonly parent: RunContext;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const sorted = Object.keys(value).toSorted();

  return Object.fromEntries(sorted.map((key) => [key, canonical(Reflect.get(value, key))]));
}

export function queryKey(name: string, input: unknown): string {
  return `${name}\0${JSON.stringify(canonical(input))}`;
}

export function isDedupable(
  contract: BusContract,
  origin: Origin,
  options: RequestOptions,
): origin is RunOrigin {
  return isQueryContract(contract) && origin.parent !== undefined && options.signal === undefined;
}

export function leaderOf(state: BusState, traceId: string, key: string): InFlightQuery | undefined {
  return state.requests.queries.get(traceId)?.get(key);
}

export function coversRemainingTime(leader: InFlightQuery, timeoutMs: number): boolean {
  return timeoutMs >= leader.expiresAt - performance.now();
}

function forget(state: BusState, traceId: string, key: string): void {
  const byKey = state.requests.queries.get(traceId);
  byKey?.delete(key);

  if (byKey?.size === 0) {
    state.requests.queries.delete(traceId);
  }
}

export function rememberLeader(state: BusState, traceId: string, key: string, leader: InFlightQuery): void {
  const byKey = state.requests.queries.get(traceId) ?? new Map<string, InFlightQuery>();
  byKey.set(key, leader);
  state.requests.queries.set(traceId, byKey);
  const forgetLeader = () => forget(state, traceId, key);
  leader.promise.then(forgetLeader, forgetLeader);
}

export function announceDeduped(
  state: BusState,
  leader: InFlightQuery,
  key: string,
  origin: RunOrigin,
): void {
  const { parent } = origin;
  const byPiece = origin.source ?? parent.piece;
  leader.counter.deduped += 1;
  state.sys(
    'request.deduped',
    { traceId: parent.traceId, key, byPiece, firstEnvelopeId: leader.envelopeId },
    { traceId: parent.traceId, hop: Math.max(parent.hop, 0), source: byPiece },
  );
}

export interface LeaderRef {
  readonly traceId: string;
  readonly key: string;
  readonly leader: InFlightQuery;
}

export function abandonUnfollowed(
  state: BusState,
  ref: LeaderRef,
  parent: AbortSignal,
  abandon: AbortController,
): void {
  const abandonIfAlone = (reason: unknown) => {
    if (ref.leader.counter.deduped === 0) {
      forget(state, ref.traceId, ref.key);
      abandon.abort(reason);
    }
  };

  if (parent.aborted) {
    abandonIfAlone(parent.reason);

    return;
  }

  const stop = onAnyAbort([parent], abandonIfAlone);
  ref.leader.promise.then(stop, stop);
}
