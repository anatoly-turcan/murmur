import type { CapabilityBus, IngressPort, Log, RequestOptions } from 'murmur';

import type { IdempotencyStore } from './idempotency-store.ts';
import type { HttpHost } from './pipeline.ts';

export interface BusHostInit {
  readonly bus: CapabilityBus;
  readonly invoke: IngressPort['invoke'];
  readonly mode: 'dev' | 'prod';
  readonly log: Log;
  readonly freshTraceId: () => string;
  readonly idempotency?: IdempotencyStore | undefined;
}

export function busHost(init: BusHostInit): HttpHost {
  return {
    mode: init.mode,
    log: init.log,
    freshTraceId: init.freshTraceId,
    idempotency: init.idempotency,
    invoke: (piece, invokeInit, fn) => init.invoke(piece, invokeInit, fn),
    request: (contract, input, options: RequestOptions) =>
      init.bus.request(contract, input as never, options),
  };
}
