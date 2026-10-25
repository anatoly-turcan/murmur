import type { Clock, Ids } from '../../model/capabilities.ts';
import type { CapabilityBus } from '../../model/capability.ts';
import type { RunContext } from '../../model/context.ts';
import type { Delivery } from '../../model/delivery.ts';
import type { Envelope } from '../../model/envelope.ts';
import type { SerializedError } from '../../model/errors.ts';
import type { EntryFn, InvokeInit } from '../../model/ingress.ts';
import type { DeliveryPolicy, DeliveryPolicyInput, PiecePolicy } from '../../model/policy.ts';
import type { ContextStorage } from '../context.ts';
import type { Subscription, Transport } from '../transport.ts';
import type { BusContract } from './contracts.ts';
import type { PiecePort } from './port.ts';

export interface LogLine {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  piece: string;
  msg: string;
  traceId?: string;
  eventId?: string;
  fields?: Record<string, unknown>;
  error?: SerializedError;
}

export interface BusLimits {
  warnBytes?: number;
  maxBytes?: number;
  maxHop?: number;
}

export interface BusOptions {
  transport: Transport;
  context: ContextStorage<RunContext>;
  instanceId?: string;
  ids?: Ids;
  clock?: Clock;
  policy?: DeliveryPolicyInput;
  limits?: BusLimits;
  observability?: { payloads: boolean };
  mode?: 'dev' | 'prod';
  sink?: (line: LogLine) => void;
  stacks?: BusStacks;
  localRequests?: boolean;
}

export interface BusStacks {
  readonly ingress?: AsyncDisposable;
  readonly capabilities?: AsyncDisposable;
}

export interface BusStats {
  pendingRequests: number;
  inflight: number;
  internalDropped: number;
  observerDropped: number;
}

export interface StopOptions {
  graceMs?: number;
  forceMs?: number;
}

export interface Bus extends CapabilityBus, AsyncDisposable {
  readonly instanceId: string;
  readonly stats: BusStats;
  register(piece: PieceRuntime): Promise<Registration>;
  observe(pattern: string, name: string, fn: (e: Envelope) => void | Promise<void>): Promise<Subscription>;
  invoke<R>(piece: string, init: InvokeInit, fn: EntryFn<R>): Promise<Awaited<R>>;
  portFor(piece: string): PiecePort;
  policyOf(piece: string): DeliveryPolicy;
  stop(reason: string, options?: StopOptions): Promise<void>;
}

export interface PieceHandlerEntry {
  readonly contract: BusContract;
  readonly handle: (input: unknown, delivery: Delivery) => unknown;
}

export type LifecycleHook = () => unknown;

export interface PieceRuntime {
  name: string;
  handlers: readonly PieceHandlerEntry[];
  emits: readonly BusContract[];
  needs?: readonly string[];
  configKeys?: readonly string[];
  policy: PiecePolicy;
  start: readonly LifecycleHook[];
  stop: readonly LifecycleHook[];
}

export interface Registration extends AsyncDisposable {
  readonly piece: string;
  readonly subscription: Subscription;
  start(): Promise<void>;
  stop(signal: AbortSignal): Promise<void>;
}
