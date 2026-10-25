import type { Clock, Ids } from '../../model/capabilities.ts';
import type { Envelope } from '../../model/envelope.ts';
import { createEnvelope } from '../envelope.ts';
import type { PublishOptions, Transport } from '../transport.ts';
import type { About, SysEmitter } from './state.ts';

const INTERNAL_PUBLISH: PublishOptions = Object.freeze({ persistent: false, expiresMs: 60_000 });

export interface InternalPublisherDeps {
  readonly transport: Transport;
  readonly ids: Ids;
  readonly clock: Clock;
  readonly instanceId: string;
  readonly dropped: () => void;
}

function internalEnvelope(
  deps: InternalPublisherDeps,
  name: string,
  payload: object,
  about: About,
): Envelope {
  const at = deps.clock.now().toString();
  const envelope = createEnvelope({
    name: `$sys.${name}`,
    payload: { ...payload, instanceId: deps.instanceId, at },
    ids: deps.ids,
    clock: deps.clock,
    ...(about.source === undefined ? {} : { source: about.source }),
  });

  if (about.traceId === undefined) {
    return envelope;
  }

  return { ...envelope, traceId: about.traceId, hop: about.hop ?? 0 };
}

export function createInternalPublisher(deps: InternalPublisherDeps): SysEmitter {
  return (name, payload, about = {}) => {
    try {
      deps.transport
        .publish(internalEnvelope(deps, name, payload, about), INTERNAL_PUBLISH)
        .catch(deps.dropped);
    } catch {
      deps.dropped();
    }
  };
}
