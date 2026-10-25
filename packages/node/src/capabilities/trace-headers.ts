const TRACE_ID = /^[0-9a-f-]{8,64}$/;
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

export interface InboundTrace {
  readonly traceId: string | undefined;
  readonly malformed: string | undefined;
}

function spanId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function traceparent(traceId: string): string {
  const hex = traceId.replaceAll('-', '').toLowerCase().slice(0, 32).padStart(32, '0');

  return `00-${hex}-${spanId()}-01`;
}

export function traceHeaders(traceId: string): Record<string, string> {
  return { 'x-murmur-trace': traceId, traceparent: traceparent(traceId) };
}

function fromTraceparent(header: string): string | undefined {
  const traceId = TRACEPARENT.exec(header)?.[1];

  return traceId !== undefined && TRACE_ID.test(traceId) ? traceId : undefined;
}

export function inboundTrace(murmur: string | undefined, parent: string | undefined): InboundTrace {
  if (murmur !== undefined && TRACE_ID.test(murmur)) {
    return { traceId: murmur, malformed: undefined };
  }

  const fromParent = parent === undefined ? undefined : fromTraceparent(parent);

  return { traceId: fromParent, malformed: murmur ?? (fromParent === undefined ? parent : undefined) };
}
