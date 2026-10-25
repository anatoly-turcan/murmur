import type { Envelope, PublishOptions, SysEvent, Transport } from 'murmur';

type OnPublish = (envelope: Envelope, options?: PublishOptions) => void;

function notify(onPublish: OnPublish, envelope: Envelope, options: PublishOptions | undefined): void {
  try {
    onPublish(envelope, options);
  } catch {
    return;
  }
}

function ingressEntryOf(envelope: Envelope): Envelope | undefined {
  if (envelope.name !== '$sys.ingress.received') {
    return undefined;
  }

  return (envelope.payload as SysEvent<'ingress.received'>).envelope;
}

function localEnvelopeOf(envelope: Envelope): Envelope | undefined {
  if (envelope.name !== '$sys.event.published') {
    return undefined;
  }

  const published = envelope.payload as SysEvent<'event.published'>;

  return published.local === true ? published.envelope : undefined;
}

function notifyCopies(onPublish: OnPublish, envelope: Envelope): void {
  const copy = ingressEntryOf(envelope) ?? localEnvelopeOf(envelope);
  if (copy !== undefined) {
    notify(onPublish, copy, undefined);
  }
}

export function withTap(transport: Transport, onPublish: OnPublish): Transport {
  return {
    get name() {
      return transport.name;
    },
    get features() {
      return transport.features;
    },
    publish: (envelope, options) => {
      notify(onPublish, envelope, options);
      notifyCopies(onPublish, envelope);

      return transport.publish(envelope, options);
    },
    subscribe: (patterns, group, handler, options) => transport.subscribe(patterns, group, handler, options),
    close: (signal) => transport.close(signal),
  };
}
