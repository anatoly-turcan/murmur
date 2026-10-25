import { serializeError, type Envelope } from 'murmur';

export type TransportStatusName = 'reconnecting' | 'reconnected' | 'error';

export interface TransportStatus {
  readonly attempt?: number;
  readonly error?: unknown;
}

export function statusEnvelope(
  instanceId: string,
  name: TransportStatusName,
  status: TransportStatus,
): Envelope {
  const id = crypto.randomUUID();
  const at = Temporal.Now.instant().toString();

  return {
    id,
    name: `$sys.transport.${name}`,
    traceId: id,
    ts: at,
    hop: 0,
    payload: {
      transport: 'amqp',
      ...(status.attempt === undefined ? {} : { attempt: status.attempt }),
      ...(status.error === undefined ? {} : { error: serializeError(status.error, false) }),
      instanceId,
      at,
    },
  };
}
