import type { ConsumeMessage } from 'amqplib';
import { parseEnvelope, type DeliveryHandler } from 'murmur';

import { directDelivery, invoke } from './delivery.ts';
import type { Link } from './session.ts';
import { DIRECT_REPLY } from './topology.ts';

export interface DirectReplies {
  has(name: string | undefined): boolean;
  add(group: string, handler: DeliveryHandler): void;
  remove(group: string): void;
  attach(link: Link): Promise<void>;
}

export function createDirectReplies(onError: (error: unknown) => void): DirectReplies {
  const handlers = new Map<string, DeliveryHandler>();
  let consumedOn: Link | undefined;

  function receive(message: ConsumeMessage | null): void {
    if (message === null) {
      return;
    }

    try {
      const envelope = parseEnvelope(message.content);
      const handler = handlers.get(envelope.name);

      if (handler !== undefined) {
        void invoke(handler, directDelivery(envelope));
      }
    } catch (error) {
      onError(error);
    }
  }

  async function attach(link: Link): Promise<void> {
    if (handlers.size === 0 || consumedOn === link) {
      return;
    }

    consumedOn = link;

    try {
      await link.publisher.consume(DIRECT_REPLY, receive, { noAck: true });
    } catch (error) {
      consumedOn = undefined;
      throw error;
    }
  }

  return {
    has: (name) => name !== undefined && handlers.has(name),
    add: (group, handler) => void handlers.set(group, handler),
    remove: (group) => void handlers.delete(group),
    attach,
  };
}
