import type { Channel, ConsumeMessage } from 'amqplib';
import type { TransportDelivery, DeliveryHandler, Envelope } from 'murmur';

import { attemptOf } from './message.ts';
import { isDirectAddress } from './topology.ts';

type NackOptions = Parameters<TransportDelivery['nack']>[1];

export interface TrackedDelivery extends TransportDelivery {
  readonly settled: Promise<void>;
}

export interface DeliveryContext {
  readonly channel: Channel;
  readonly message: ConsumeMessage;
  readonly envelope: Envelope;
  readonly queue: string;
  readonly noAck: boolean;
  readonly closers: Set<() => void>;
  readonly retry: (message: ConsumeMessage, name: string, queue: string, delayMs: number) => Promise<void>;
  readonly afterRetryConfirm: ((channel: Channel) => Promise<void> | void) | undefined;
  readonly onError: (error: unknown) => void;
}

async function retryThenAck(ctx: DeliveryContext, delayMs: number): Promise<void> {
  try {
    await ctx.retry(ctx.message, ctx.envelope.name, ctx.queue, delayMs);
  } catch (error) {
    ctx.onError(error);
    ctx.channel.nack(ctx.message, false, true);

    return;
  }

  await ctx.afterRetryConfirm?.(ctx.channel);
  ctx.channel.ack(ctx.message);
}

async function nackWith(ctx: DeliveryContext, requeue: boolean, options: NackOptions = {}): Promise<void> {
  if (!requeue) {
    return ctx.channel.nack(ctx.message, false, false);
  }

  if (options.consumeAttempt === false) {
    return ctx.channel.nack(ctx.message, false, true);
  }

  await retryThenAck(ctx, options.delayMs ?? 0);
}

export function createDelivery(ctx: DeliveryContext): TrackedDelivery {
  const { promise: settled, resolve } = Promise.withResolvers<void>();
  let done = false;
  ctx.closers.add(resolve);

  const settle = async (work: () => Promise<void> | void) => {
    if (done) {
      return;
    }

    done = true;

    try {
      if (!ctx.noAck) {
        await work();
      }
    } catch (error) {
      ctx.onError(error);
    } finally {
      ctx.closers.delete(resolve);
      resolve();
    }
  };
  const replyAddress = ctx.message.properties.replyTo;

  return {
    envelope: ctx.envelope,
    attempt: attemptOf(ctx.message),
    redelivered: ctx.message.fields.redelivered,
    ...(isDirectAddress(replyAddress) ? { replyAddress } : {}),
    settled,
    ack: () => settle(() => ctx.channel.ack(ctx.message)),
    nack: (requeue, options) => settle(() => nackWith(ctx, requeue, options)),
  };
}

const settledAlready = async () => undefined;

export function directDelivery(envelope: Envelope): TransportDelivery {
  return { envelope, attempt: 1, redelivered: false, ack: settledAlready, nack: settledAlready };
}

export async function invoke(handler: DeliveryHandler, delivery: TransportDelivery): Promise<void> {
  try {
    await handler(delivery);
  } catch {
    await delivery.nack(true);
  }
}
