import type { EnterInit, RunContext } from '../../model/context.ts';
import type { ContractClass } from '../../model/contract-class.ts';
import type { DeliveryPolicy, RequestOptions } from '../../model/policy.ts';
import { busContractOf } from './contracts.ts';
import { consoleSink, systemClock, systemIds } from './defaults.ts';
import { createInternalPublisher } from './internal.ts';
import { invokeEntry } from './invoke.ts';
import { observe } from './observe.ts';
import { DEFAULT_POLICY, mergePolicy } from './policy.ts';
import { piecePort } from './port.ts';
import { publishEvent } from './publish.ts';
import { registerPiece } from './register.ts';
import { sendRequest } from './request.ts';
import { stopBus } from './shutdown.ts';
import type { BusState, Limits } from './state.ts';
import type { Bus, BusOptions, BusStats } from './types.ts';

const DEFAULT_LIMITS: Limits = Object.freeze({ warnBytes: 64 * 1024, maxBytes: 1024 * 1024, maxHop: 32 });

function createState(options: BusOptions): BusState {
  const ids = options.ids ?? systemIds;
  const clock = options.clock ?? systemClock;
  const instanceId = options.instanceId ?? ids.short();
  const mode = options.mode ?? 'dev';
  const counters = { internalDropped: 0, observerDropped: 0, deliveries: 0 };
  const sys = createInternalPublisher({
    transport: options.transport,
    ids,
    clock,
    instanceId,
    dropped: () => {
      counters.internalDropped++;
    },
  });

  return {
    transport: options.transport,
    context: options.context,
    ids,
    clock,
    instanceId,
    replyTo: `$reply.${instanceId}`,
    policy: mergePolicy(DEFAULT_POLICY, options.policy),
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    mode,
    payloads: options.observability?.payloads ?? mode === 'dev',
    localRequests: options.localRequests ?? true,
    sink: options.sink ?? consoleSink,
    stopping: new AbortController(),
    closing: new AbortController(),
    sys,
    inflight: new Map(),
    zombies: new Set(),
    responders: new Map(),
    registrations: [],
    pieces: new Map(),
    scopes: new WeakMap(),
    subscriptions: new AsyncDisposableStack(),
    stacks: options.stacks ?? {},
    observers: new Set(),
    requests: {
      pending: new Map(),
      finished: new Map(),
      inbound: new Set(),
      queries: new Map(),
      subscription: undefined,
      closed: false,
    },
    counters,
  };
}

function enterRun(state: BusState, init: EnterInit): RunContext {
  return {
    piece: init.piece,
    traceId: init.traceId ?? state.ids.uuid(),
    hop: -1,
    signal: init.signal ?? state.closing.signal,
    internal: false,
  };
}

function origin(state: BusState): { parent: RunContext | undefined; source: string | undefined } {
  const parent = state.context.getStore();

  return { parent, source: parent?.piece };
}

function policyOf(state: BusState, piece: string): DeliveryPolicy {
  return state.pieces.get(piece)?.policy ?? state.policy;
}

function statsOf(state: BusState): BusStats {
  return {
    get pendingRequests() {
      return state.requests.pending.size;
    },
    get inflight() {
      return state.inflight.size;
    },
    get internalDropped() {
      return state.counters.internalDropped;
    },
    get observerDropped() {
      return state.counters.observerDropped;
    },
  };
}

export function createBus(options: BusOptions): Bus {
  const state = createState(options);
  let stopped: Promise<void> | undefined;
  const stop: Bus['stop'] = (reason, stopOptions) => (stopped ??= stopBus(state, reason, stopOptions));

  return {
    instanceId: state.instanceId,
    stopping: state.stopping.signal,
    stats: statsOf(state),
    emit: ((contract: ContractClass, payload: unknown) =>
      publishEvent(state, busContractOf(contract), payload, origin(state))) as Bus['emit'],
    request: ((contract: ContractClass, payload: unknown, requestOptions?: RequestOptions) =>
      sendRequest(state, busContractOf(contract), payload, origin(state), requestOptions)) as Bus['request'],
    enter: (init, fn) => state.context.run(enterRun(state, init), fn),
    register: (piece) => registerPiece(state, piece),
    observe: (pattern, name, fn) => observe(state, pattern, name, fn),
    invoke: (piece, init, fn) => invokeEntry(state, piece, init, fn),
    portFor: (piece) => piecePort(state, piece),
    policyOf: (piece) => policyOf(state, piece),
    stop,
    [Symbol.asyncDispose]: () => stop('dispose'),
  };
}
