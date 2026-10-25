import { createEnvelope, type Clock, type Ids, type SysName, type SysPayloads, type Transport } from 'murmur';

export type SysPayload<K extends SysName> = SysPayloads[K];

export interface About {
  readonly traceId?: string | undefined;
  readonly hop?: number | undefined;
  readonly source?: string | undefined;
}

export type SysPublisher = <K extends SysName>(name: K, payload: SysPayload<K>, about?: About) => void;

export interface SysPublisherDeps {
  readonly transport: Transport;
  readonly ids: Ids;
  readonly clock: Clock;
  readonly instanceId: string;
}

const INTERNAL_PUBLISH = Object.freeze({ persistent: false, expiresMs: 60_000 });

function sysEnvelope(deps: SysPublisherDeps, name: string, payload: object, about: About) {
  const envelope = createEnvelope({
    name: `$sys.${name}`,
    payload: { ...payload, instanceId: deps.instanceId, at: deps.clock.now().toString() },
    ids: deps.ids,
    clock: deps.clock,
    ...(about.source === undefined ? {} : { source: about.source }),
  });

  if (about.traceId === undefined) {
    return envelope;
  }

  return { ...envelope, traceId: about.traceId, hop: Math.max(about.hop ?? 0, 0) };
}

export function createSysPublisher(deps: SysPublisherDeps): SysPublisher {
  return (name, payload, about = {}) => {
    try {
      deps.transport.publish(sysEnvelope(deps, name, payload, about), INTERNAL_PUBLISH).catch(() => {});
    } catch {
      return;
    }
  };
}
