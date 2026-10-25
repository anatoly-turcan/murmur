import { setTimeout as delay } from 'node:timers/promises';

import type { Channel, ConsumeMessage } from 'amqplib';
import { parseEnvelope, type DeliveryHandler } from 'murmur';

import { createDelivery, invoke, type DeliveryContext } from './delivery.ts';
import { backoffMs } from './options.ts';
import type { Link, Session } from './session.ts';
import { assertGroup, type GroupSpec } from './topology.ts';

export interface Consumer {
  readonly spec: GroupSpec;
  readonly handler: DeliveryHandler;
  readonly unsettled: Set<Promise<void>>;
  channel: Channel | undefined;
  link: Link | undefined;
  tag: string | undefined;
  stopped: boolean;
  queue: Promise<void>;
}

export interface ConsumerDeps {
  readonly session: Session;
  readonly delivery: Pick<DeliveryContext, 'retry' | 'afterRetryConfirm' | 'onError'>;
  readonly onRevived: (attempt: number) => void;
}

const ignore = () => undefined;

export function createConsumer(spec: GroupSpec, handler: DeliveryHandler): Consumer {
  return {
    spec,
    handler,
    unsettled: new Set(),
    channel: undefined,
    link: undefined,
    tag: undefined,
    stopped: false,
    queue: Promise.resolve(),
  };
}

interface Attached {
  readonly channel: Channel;
  readonly closers: Set<() => void>;
}

function receive(consumer: Consumer, attached: Attached, message: ConsumeMessage, deps: ConsumerDeps): void {
  const { noAck, queue } = consumer.spec;
  const { channel, closers } = attached;
  let envelope;

  try {
    envelope = parseEnvelope(message.content);
  } catch (error) {
    if (!noAck) {
      channel.nack(message, false, false);
    }

    deps.delivery.onError(error);

    return;
  }

  const delivery = createDelivery({ ...deps.delivery, channel, closers, message, envelope, queue, noAck });
  consumer.unsettled.add(delivery.settled);
  void delivery.settled.then(() => consumer.unsettled.delete(delivery.settled));
  void invoke(consumer.handler, delivery);
}

function onClosed(consumer: Consumer, attached: Attached, deps: ConsumerDeps): void {
  const { channel, closers } = attached;
  for (const close of closers) {
    close();
  }

  closers.clear();

  if (consumer.channel !== channel) {
    return;
  }

  consumer.channel = undefined;

  if (!consumer.stopped) {
    void revive(consumer, deps);
  }
}

async function attach(consumer: Consumer, link: Link, deps: ConsumerDeps): Promise<void> {
  const channel = await link.connection.createChannel();
  const attached: Attached = { channel, closers: new Set() };
  channel.on('error', ignore);
  channel.on('close', () => onClosed(consumer, attached, deps));
  consumer.channel = channel;
  consumer.link = link;
  const { spec } = consumer;
  await channel.prefetch(spec.prefetch, false);
  await assertGroup(channel, spec);
  const onMessage = (message: ConsumeMessage | null) => {
    if (message === null) {
      void channel.close().catch(ignore);
    } else {
      receive(consumer, attached, message, deps);
    }
  };
  const { consumerTag } = await channel.consume(spec.queue, onMessage, { noAck: spec.noAck });
  consumer.tag = consumerTag;
}

function needsAttach(consumer: Consumer, link: Link): boolean {
  return !consumer.stopped && link.alive && (consumer.channel === undefined || consumer.link !== link);
}

export function ensureAttached(consumer: Consumer, link: Link, deps: ConsumerDeps): Promise<void> {
  const next = consumer.queue.then(() =>
    needsAttach(consumer, link) ? attach(consumer, link, deps) : undefined,
  );
  consumer.queue = next.catch(ignore);

  return next;
}

async function revive(consumer: Consumer, deps: ConsumerDeps, attempt = 1): Promise<void> {
  await delay(backoffMs(attempt), undefined, { ref: false });
  const link = deps.session.link;
  if (link === undefined || consumer.stopped || consumer.channel !== undefined) {
    return;
  }

  const revived = await ensureAttached(consumer, link, deps).then(
    () => true,
    () => false,
  );

  if (!revived) {
    await revive(consumer, deps, attempt + 1);
  } else if (consumer.channel !== undefined) {
    deps.onRevived(attempt);
  }
}

export async function cancel(consumer: Consumer): Promise<void> {
  consumer.stopped = true;
  const { channel, tag } = consumer;
  if (channel === undefined || tag === undefined) {
    return;
  }

  await channel.cancel(tag).catch(ignore);
}

export async function dropExclusive(consumer: Consumer): Promise<void> {
  if (!consumer.spec.exclusive) {
    return;
  }

  await consumer.channel?.deleteQueue(consumer.spec.queue).catch(ignore);
}

export async function retire(consumer: Consumer): Promise<void> {
  await cancel(consumer);
  await Promise.allSettled(consumer.unsettled);
  await consumer.channel?.close().catch(ignore);
}
