import type { Envelope, SerializedError } from 'murmur';

export interface EnvMeta {
  piece?: string;
  attempt?: number;
  durationMs?: number;
  failed?: boolean;
  internal: boolean;
}

export interface StoredEnvelope {
  seq: number;
  envelope: Envelope;
  meta: EnvMeta;
}

export interface TraceDelivery {
  piece: string;
  attempt: number;
  receivedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: 'acked' | 'failed' | 'retried' | 'deadLettered' | 'inflight';
  error?: string;
  reason?: string;
}

export interface TraceNode {
  id: string;
  parentId: string | null;
  depth: number;
  envelope: Envelope;
  deliveries: TraceDelivery[];
  reply?: { envelopeId: string; durationMs: number; timedOut: boolean; rejected?: number };
  deduped?: { count: number; by: string[] };
}

export interface Trace {
  traceId: string;
  root: StoredEnvelope;
  nodes: TraceNode[];
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  failed: boolean;
  maxHop: number;
  background?: { piece: string };
}

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

export function callersSharing(deduped: { count: number }): number {
  return deduped.count + 1;
}
