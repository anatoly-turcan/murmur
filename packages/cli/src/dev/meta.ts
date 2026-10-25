import type { EnvMeta } from '@murmur/dev-protocol';
import { isInternal, type Envelope } from 'murmur';

const FAILURES = new Set(['$sys.delivery.failed', '$sys.delivery.deadlettered', '$sys.delivery.timeout']);

function field<T>(payload: unknown, key: string, type: 'string' | 'number'): T | undefined {
  const value = typeof payload === 'object' && payload !== null ? Reflect.get(payload, key) : undefined;

  return typeof value === type ? (value as T) : undefined;
}

function internalMeta(envelope: Envelope): EnvMeta {
  const { payload } = envelope;
  const piece = field<string>(payload, 'piece', 'string') ?? envelope.source;
  const attempt = field<number>(payload, 'attempt', 'number') ?? field<number>(payload, 'attempts', 'number');
  const durationMs = field<number>(payload, 'durationMs', 'number');

  return {
    internal: true,
    ...(piece === undefined ? {} : { piece }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(FAILURES.has(envelope.name) ? { failed: true } : {}),
  };
}

export function metaOf(envelope: Envelope): EnvMeta {
  if (isInternal(envelope.name)) {
    return internalMeta(envelope);
  }

  return { internal: false, ...(envelope.source === undefined ? {} : { piece: envelope.source }) };
}

export function isReplyName(name: string): boolean {
  return name.startsWith('$reply.');
}

export function isIngressName(name: string): boolean {
  return name.startsWith('$ingress.');
}
