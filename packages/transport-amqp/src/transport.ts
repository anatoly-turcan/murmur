import type { ConsumeMessage } from 'amqplib';
import {
  NoRouteError,
  TransportError,
  type DeliveryHandler,
  type Envelope,
  type PublishOptions,
  type SubscribeOptions,
  type Subscription,
  type Transport,
  type TransportFeatures,
} from 'murmur';

import {
  cancel,
  createConsumer,
  dropExclusive,
  ensureAttached,
  retire,
  type Consumer,
  type ConsumerDeps,
} from './consumer.ts';
import { createDirectReplies } from './direct-reply.ts';
import { eventMessage, retryMessage } from './message.ts';
import {
  resolveOptions,
  type AmqpHooks,
  type AmqpTransportOptions,
  type ResolvedOptions,
} from './options.ts';
import { createPublisher } from './publisher.ts';
import { createSession, type Link } from './session.ts';
import { statusEnvelope, type TransportStatus, type TransportStatusName } from './status.ts';
import { assertRetry, isObserverGroup, isReplyGroup, queueName, type GroupSpec } from './topology.ts';

export interface AmqpTransport extends Transport {
  readonly instanceId: string;
}

const FEATURES: TransportFeatures = Object.freeze({
  orderedWithinGroup: true,
  detectsNoRoute: true,
  nativeRedelivery: true,
  directReply: true,
});

const STATUS_PUBLISH: PublishOptions = Object.freeze({ persistent: false, expiresMs: 60_000 });
const ignore = () => undefined;

function groupSpec(
  options: ResolvedOptions,
  patterns: readonly string[],
  group: string,
  subscribe: SubscribeOptions,
): GroupSpec {
  return {
    group,
    queue: queueName(group),
    patterns,
    exclusive: subscribe.exclusive ?? false,
    noAck: isObserverGroup(group),
    prefetch: subscribe.prefetch,
    quorum: options.quorum,
    retention: subscribe.retention ?? {},
  };
}

function untilSettledOrAborted(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return work.then(ignore);
  }

  if (signal.aborted) {
    return Promise.resolve();
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  signal.addEventListener('abort', () => resolve(), { once: true });
  void work.then(() => resolve());

  return promise;
}

function subscription(
  patterns: readonly string[],
  group: string,
  release: () => Promise<void>,
  signal: AbortSignal | undefined,
): Subscription {
  let released: Promise<void> | undefined;
  const unsubscribe = () => (released ??= release());

  if (signal?.aborted === true) {
    void unsubscribe();
  } else {
    signal?.addEventListener('abort', () => void unsubscribe(), { once: true });
  }

  return { patterns: [...patterns], group, unsubscribe, [Symbol.asyncDispose]: unsubscribe };
}

export function createAmqpTransport(input: AmqpTransportOptions): Promise<AmqpTransport> {
  return createTransport(input, {});
}

export async function createTransport(input: AmqpTransportOptions, hooks: AmqpHooks): Promise<AmqpTransport> {
  const options = resolveOptions(input);
  const groups = new Set<string>();
  const consumers = new Map<string, Consumer>();
  const retired = new Set<Consumer>();
  const tiers = new WeakMap<Link, Set<string>>();
  let closing: Promise<void> | undefined;

  const publisher = createPublisher(() => session.link, options.publishBuffer);
  const status = (name: TransportStatusName, payload: TransportStatus) => {
    const envelope = statusEnvelope(options.instanceId, name, payload);
    publisher.send(eventMessage(envelope, STATUS_PUBLISH, false)).catch(ignore);
  };
  const directReplies = createDirectReplies((error) => status('error', { error }));

  async function retry(message: ConsumeMessage, name: string, queue: string, delayMs: number): Promise<void> {
    const link = session.link;
    if (link === undefined) {
      throw new TransportError('amqp connection is down');
    }

    const outgoing = retryMessage(message, name, queue, delayMs);
    const asserted = tiers.get(link) ?? new Set<string>();
    tiers.set(link, asserted);

    if (outgoing.route !== undefined && !asserted.has(outgoing.route.queue)) {
      await assertRetry(link.publisher, queue, outgoing.route);
      asserted.add(outgoing.route.queue);
    }

    await publisher.sendOn(link, outgoing).catch((error: unknown) => {
      if (error instanceof NoRouteError && outgoing.route !== undefined) {
        asserted.delete(outgoing.route.queue);
      }

      throw error;
    });
  }

  const session = createSession(options, {
    onReturn: (message) => publisher.onReturn(message),
    onDown: (error) => status('reconnecting', { error }),
    onUp: async (link) => {
      await Promise.all([...consumers.values()].map((consumer) => ensureAttached(consumer, link, deps)));
      await directReplies.attach(link);
    },
    onLive: (link, attempt) => {
      publisher.flush(link);

      if (attempt > 0) {
        status('reconnected', { attempt });
      }
    },
  });
  const deps: ConsumerDeps = {
    session,
    delivery: {
      retry,
      afterRetryConfirm: hooks.afterRetryConfirm,
      onError: (error) => status('error', { error }),
    },
    onRevived: (attempt) => status('reconnected', { attempt }),
  };

  function assertOpen(): void {
    if (closing !== undefined) {
      throw new TransportError('amqp transport is closed', { retryable: false });
    }
  }

  async function subscribeDirect(group: string, handler: DeliveryHandler): Promise<() => Promise<void>> {
    directReplies.add(group, handler);

    try {
      await directReplies.attach(await session.ready());
    } catch (error) {
      directReplies.remove(group);
      throw error;
    }

    return async () => {
      directReplies.remove(group);
      groups.delete(group);
    };
  }

  async function subscribeQueue(spec: GroupSpec, handler: DeliveryHandler): Promise<() => Promise<void>> {
    const consumer = createConsumer(spec, handler);
    consumers.set(spec.group, consumer);

    try {
      await ensureAttached(consumer, await session.ready(), deps);
    } catch (error) {
      consumers.delete(spec.group);
      await retire(consumer);
      throw error;
    }

    return async () => {
      consumers.delete(spec.group);
      groups.delete(spec.group);
      retired.add(consumer);
      await cancel(consumer);
      await dropExclusive(consumer);
      void retire(consumer).finally(() => retired.delete(consumer));
    };
  }

  async function subscribe(
    patterns: readonly string[],
    group: string,
    handler: DeliveryHandler,
    subscribeOptions: SubscribeOptions = { prefetch: 1 },
  ): Promise<Subscription> {
    assertOpen();

    if (groups.has(group)) {
      throw new TransportError(`group already subscribed: ${group}`, { retryable: false });
    }

    groups.add(group);

    try {
      const release =
        options.directReplyTo && isReplyGroup(group)
          ? await subscribeDirect(group, handler)
          : await subscribeQueue(groupSpec(options, patterns, group, subscribeOptions), handler);

      return subscription(patterns, group, release, subscribeOptions.signal);
    } catch (cause) {
      groups.delete(group);
      throw cause instanceof TransportError
        ? cause
        : new TransportError(`amqp subscribe failed: ${group}`, { cause });
    }
  }

  async function publish(envelope: Envelope, publishOptions: PublishOptions = {}): Promise<void> {
    assertOpen();
    await publisher.send(eventMessage(envelope, publishOptions, directReplies.has(envelope.replyTo)));
  }

  async function shutdown(signal: AbortSignal | undefined): Promise<void> {
    const all = [...consumers.values(), ...retired];
    await Promise.all(all.map(cancel));
    await untilSettledOrAborted(Promise.allSettled(all.flatMap((c) => Array.from(c.unsettled))), signal);
    publisher.close();
    await session.close();
  }

  await session.start();

  return {
    name: 'amqp',
    features: FEATURES,
    instanceId: options.instanceId,
    publish,
    subscribe,
    close: (signal) => (closing ??= shutdown(signal)),
  };
}
