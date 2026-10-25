import { isInternal, type Envelope } from 'murmur';

export interface PayloadPolicy {
  readonly redact: boolean;
  readonly capBytes: number;
}

const UNITS: Readonly<Record<string, number>> = { b: 1, kb: 1024, mb: 1024 * 1024 };

export function parseSize(text: string): number | null {
  const match = /^(\d+)\s*(b|kb|mb)?$/i.exec(text.trim());
  if (match === null) {
    return null;
  }

  return Number(match[1]) * (UNITS[(match[2] ?? 'b').toLowerCase()] ?? 1);
}

function bytesOf(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload) ?? '');
}

function preview(json: string, capBytes: number): string {
  return Buffer.from(json)
    .subarray(0, capBytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
}

function truncate(payload: unknown, capBytes: number): unknown {
  const bytes = bytesOf(payload);
  if (bytes <= capBytes) {
    return payload;
  }

  return { $truncated: true, bytes, preview: preview(JSON.stringify(payload), capBytes) };
}

function shrink(payload: unknown, policy: PayloadPolicy): unknown {
  return policy.redact ? { $redacted: true, bytes: bytesOf(payload) } : truncate(payload, policy.capBytes);
}

function field(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null ? Reflect.get(payload, key) : undefined;
}

function withField(envelope: Envelope, key: string, value: unknown): Envelope {
  return { ...envelope, payload: { ...(envelope.payload as object), [key]: value } };
}

function shrinkNested(envelope: Envelope, policy: PayloadPolicy): Envelope {
  const inner = field(envelope.payload, 'envelope');
  if (typeof inner !== 'object' || inner === null) {
    return envelope;
  }

  const { payload } = inner as Envelope;

  return withField(envelope, 'envelope', { ...inner, payload: shrink(payload, policy) });
}

function shrinkLogFields(envelope: Envelope, policy: PayloadPolicy): Envelope {
  const fields = field(envelope.payload, 'fields');
  const shrunk = fields === undefined ? fields : shrink(fields, policy);

  return shrunk === fields ? envelope : withField(envelope, 'fields', shrunk);
}

export function applyPayloadPolicy(envelope: Envelope, policy: PayloadPolicy): Envelope {
  if (!isInternal(envelope.name)) {
    return { ...envelope, payload: shrink(envelope.payload, policy) };
  }

  if (envelope.name === '$sys.log') {
    return shrinkLogFields(envelope, policy);
  }

  return shrinkNested(envelope, policy);
}
