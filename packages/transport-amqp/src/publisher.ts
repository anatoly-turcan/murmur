import type { Message } from 'amqplib';
import { NoRouteError, TransportError } from 'murmur';

import type { Outgoing } from './message.ts';
import type { Link } from './session.ts';

export interface Publisher {
  send(message: Outgoing): Promise<void>;
  sendOn(link: Link, message: Outgoing): Promise<void>;
  flush(link: Link): void;
  onReturn(message: Message): void;
  close(): void;
}

interface Buffered {
  readonly message: Outgoing;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

const returnKey = (exchange: string, key: string, messageId: unknown): string =>
  `${exchange}\u0000${key}\u0000${String(messageId)}`;

const keyOf = (message: Outgoing): string =>
  returnKey(message.exchange, message.key, message.properties.messageId);

export function createPublisher(current: () => Link | undefined, capacity: number): Publisher {
  const returned = new Map<string, boolean>();
  let buffer: Buffered[] = [];
  let closed = false;

  function confirmed(message: Outgoing, error: unknown): Error | undefined {
    const mandatory = message.properties.mandatory === true;
    const wasReturned = mandatory && returned.get(keyOf(message)) === true;

    if (mandatory) {
      returned.delete(keyOf(message));
    }

    if (error !== null && error !== undefined) {
      return new TransportError(`amqp publish not confirmed: ${message.name}`, { cause: error });
    }

    return wasReturned ? new NoRouteError(message.name) : undefined;
  }

  function sendOn(link: Link, message: Outgoing): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();

    if (message.properties.mandatory === true) {
      returned.set(keyOf(message), false);
    }

    try {
      link.publisher.publish(message.exchange, message.key, message.content, message.properties, (error) => {
        const failure = confirmed(message, error);
        if (failure === undefined) {
          resolve();
        } else {
          reject(failure);
        }
      });
    } catch (cause) {
      returned.delete(keyOf(message));
      reject(new TransportError(`amqp publish failed: ${message.name}`, { cause }));
    }

    return promise;
  }

  function enqueue(message: Outgoing): Promise<void> {
    if (buffer.length >= capacity) {
      return Promise.reject(new TransportError(`amqp publish buffer full (${capacity})`));
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    buffer.push({ message, resolve, reject });

    return promise;
  }

  return {
    send: (message) => {
      if (closed) {
        return Promise.reject(new TransportError('amqp transport is closed', { retryable: false }));
      }

      const link = current();

      return link === undefined ? enqueue(message) : sendOn(link, message);
    },
    sendOn,
    flush: (link) => {
      const queued = buffer;
      buffer = [];

      for (const item of queued) {
        sendOn(link, item.message).then(item.resolve, item.reject);
      }
    },
    onReturn: (message) => {
      const key = returnKey(message.fields.exchange, message.fields.routingKey, message.properties.messageId);
      if (returned.has(key)) {
        returned.set(key, true);
      }
    },
    close: () => {
      closed = true;
      const queued = buffer;
      buffer = [];

      for (const item of queued) {
        item.reject(new TransportError('amqp transport is closed', { retryable: false }));
      }
    },
  };
}
