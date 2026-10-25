import type { Envelope } from './envelope.ts';
import type { SerializedError } from './errors.ts';
import type { DeliveryPolicy } from './policy.ts';

type FailurePhase = 'handler' | 'emit' | 'reply';
type Optional<T> = T | undefined;

interface DeliveryRef {
  deliveryId: string;
  envelopeId: string;
  name: string;
  piece: string;
}

interface CapabilityTiming {
  name: string;
  durationMs: number;
}

interface TransportStatus {
  transport: string;
  attempt?: Optional<number>;
  error?: Optional<SerializedError>;
}

interface RequestRef {
  correlationId: string;
  name: string;
}

interface IngressRef {
  piece: string;
  transport: string;
  binding: string;
  traceId: string;
}

type FailureReason = 'requester-gone';

interface JobRef {
  id: string;
  contract: string;
  piece: string;
  attempt: number;
}

export interface SysPayloads {
  'runtime.started': {
    pid: number;
    transport: string;
    pieces: string[];
    capabilities: string[];
    configSummary: Record<string, string[]>;
  };
  'runtime.stopping': { reason: string };
  'runtime.stopped': { drained: boolean; forced: boolean; durationMs: number };
  'piece.started': {
    piece: string;
    group: string;
    handles: { name: string; kind: 'responder' | 'listener' }[];
    emits: string[];
    needs: string[];
    configKeys: string[];
    policy: DeliveryPolicy;
  };
  'piece.stopped': { piece: string };
  'piece.failed': { piece: string; phase: 'load' | 'config' | 'needs' | 'subscribe'; error: SerializedError };
  'capability.started': CapabilityTiming;
  'capability.stopped': CapabilityTiming;
  'capability.failed': { name: string; phase: 'start' | 'stop'; error: SerializedError };
  'event.published': {
    envelopeId: string;
    name: string;
    traceId: string;
    causationId?: Optional<string>;
    correlationId?: Optional<string>;
    hop: number;
    source?: Optional<string>;
    bytes: number;
    late: boolean;
    local?: Optional<boolean>;
    envelope?: Optional<Envelope>;
  };
  'event.unrouted': { envelopeId: string; name: string; source?: Optional<string> };
  'delivery.received': DeliveryRef & {
    attempt: number;
    redelivered: boolean;
    traceId: string;
    deadline: Optional<string>;
  };
  'delivery.acked': DeliveryRef & { attempt: number; durationMs: number; replied: boolean };
  'delivery.failed': DeliveryRef & {
    attempt: number;
    durationMs: number;
    error: SerializedError;
    willRetry: boolean;
    phase: FailurePhase;
    reason?: Optional<FailureReason>;
  };
  'delivery.retried': DeliveryRef & { nextAttempt: number; delayMs: number };
  'delivery.timeout': DeliveryRef & { attempt: number; timeoutMs: number };
  'delivery.deadlettered': {
    deliveryId: string;
    envelope: Envelope;
    piece: string;
    attempts: number;
    error: SerializedError;
    phase: FailurePhase | 'validate' | 'no-handler';
    reason?: Optional<FailureReason>;
  };
  'delivery.reply-ignored': { piece: string; name: string };
  'delivery.zombie-failed': { deliveryId: string; piece: string; error: SerializedError };
  'request.sent': RequestRef & { envelopeId: string; piece: string; traceId: string; timeoutMs: number };
  'request.completed': RequestRef & {
    piece: string;
    durationMs: number;
    ok: boolean;
    error?: Optional<SerializedError>;
    deduped?: Optional<number>;
  };
  'request.deduped': { traceId: string; key: string; byPiece: string; firstEnvelopeId: string };
  'request.timeout': RequestRef & { piece: string; timeoutMs: number };
  'request.late-reply': RequestRef;
  'request.duplicate-reply': RequestRef;
  'emit.background': { piece: string; contract: string };
  'ingress.received': IngressRef & { envelope: Envelope };
  'ingress.completed': IngressRef & { durationMs: number };
  'ingress.failed': IngressRef & { durationMs: number; error: SerializedError };
  'job.claimed': JobRef & { groupKey?: Optional<string> };
  'job.succeeded': JobRef & { durationMs: number };
  'job.failed': JobRef & { durationMs: number; error: SerializedError; nextRunAt: string };
  'job.dead': JobRef & { durationMs: number; error: SerializedError };
  log: {
    level: 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    piece: string;
    traceId?: Optional<string>;
    eventId?: Optional<string>;
    deliveryId?: Optional<string>;
    attempt?: Optional<number>;
    fields?: Optional<Record<string, unknown>>;
    error?: Optional<SerializedError>;
  };
  'transport.reconnecting': TransportStatus;
  'transport.reconnected': TransportStatus;
  'transport.error': TransportStatus;
}

export type SysName = keyof SysPayloads;
export type JobSysName = Extract<SysName, `job.${string}`>;
export type SysEvent<K extends SysName> = SysPayloads[K] & { instanceId: string; at: string };
