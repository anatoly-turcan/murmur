import type { StoredEnvelope } from '@murmur/dev-protocol';

export type DeliveryKind = 'received' | 'acked' | 'failed' | 'retried' | 'timeout' | 'deadlettered';

export interface DeliveryFact {
  kind: DeliveryKind;
  piece: string;
  envelopeId: string;
  attempt: number;
  durationMs: number | null;
  willRetry: boolean;
  error: string | null;
  at: number;
}

const DELIVERY_PREFIX = '$sys.delivery.';
const KINDS = new Set<string>(['received', 'acked', 'failed', 'retried', 'timeout', 'deadlettered']);

type Payload = Record<string, unknown>;

function asPayload(value: unknown): Payload {
  return typeof value === 'object' && value !== null ? (value as Payload) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function envelopeIdOf(payload: Payload): string | null {
  return str(payload['envelopeId']) ?? str(asPayload(payload['envelope'])['id']);
}

function attemptOf(kind: DeliveryKind, payload: Payload): number {
  if (kind === 'retried') {
    return (num(payload['nextAttempt']) ?? 2) - 1;
  }

  if (kind === 'deadlettered') {
    return num(payload['attempts']) ?? 1;
  }

  return num(payload['attempt']) ?? 1;
}

function errorOf(payload: Payload): string | null {
  return str(asPayload(payload['error'])['message']);
}

export function deliveryFact(stored: StoredEnvelope): DeliveryFact | null {
  const { envelope, meta } = stored;
  if (!envelope.name.startsWith(DELIVERY_PREFIX)) {
    return null;
  }

  const kind = envelope.name.slice(DELIVERY_PREFIX.length);
  if (!KINDS.has(kind)) {
    return null;
  }

  const payload = asPayload(envelope.payload);
  const piece = str(payload['piece']) ?? meta.piece ?? null;
  const envelopeId = envelopeIdOf(payload);

  if (!piece || !envelopeId) {
    return null;
  }

  const typed = kind as DeliveryKind;

  return {
    kind: typed,
    piece,
    envelopeId,
    attempt: attemptOf(typed, payload),
    durationMs: num(payload['durationMs']),
    willRetry: payload['willRetry'] === true,
    error: errorOf(payload),
    at: Date.parse(envelope.ts),
  };
}
