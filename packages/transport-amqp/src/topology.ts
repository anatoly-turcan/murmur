import type { Channel, Options } from 'amqplib';

export const EVENTS = 'murmur.events';
export const DLX = 'murmur.dlx';
export const DEAD = 'murmur.dead';
export const RETRY = 'murmur.retry';
export const DIRECT_REPLY = 'amq.rabbitmq.reply-to';
export const TIERS: readonly number[] = [250, 1_000, 5_000, 30_000];

const OBSERVER = '$observer.';
const REPLY = '$reply.';

export interface GroupSpec {
  readonly group: string;
  readonly queue: string;
  readonly patterns: readonly string[];
  readonly exclusive: boolean;
  readonly noAck: boolean;
  readonly prefetch: number;
  readonly quorum: boolean;
  readonly retention: { readonly maxLength?: number; readonly ttlMs?: number };
}

export interface RetryRoute {
  readonly tier: number;
  readonly queue: string;
  readonly key: string;
}

export const isObserverGroup = (group: string): boolean => group.startsWith(OBSERVER);
export const isReplyGroup = (group: string): boolean => group.startsWith(REPLY);
export const isDirectAddress = (address: string | undefined): address is string =>
  address?.startsWith(DIRECT_REPLY) === true;

export function queueName(group: string): string {
  if (isObserverGroup(group)) {
    return `murmur.obs.${group.slice(OBSERVER.length)}`;
  }

  if (isReplyGroup(group)) {
    return `murmur.reply.${group.slice(REPLY.length)}`;
  }

  return `murmur.q.${group.replaceAll('/', '.')}`;
}

export function tierFor(delayMs: number): number {
  return TIERS.find((tier) => tier >= delayMs) ?? TIERS[TIERS.length - 1] ?? delayMs;
}

export function retryRoute(queue: string, delayMs: number): RetryRoute {
  const tier = tierFor(delayMs);

  return { tier, queue: `murmur.retry.${queue}.${tier}`, key: `${queue}.${tier}` };
}

export async function assertBase(channel: Channel): Promise<void> {
  await channel.assertExchange(EVENTS, 'topic', { durable: true });
  await channel.assertExchange(DLX, 'fanout', { durable: true });
  await channel.assertExchange(RETRY, 'direct', { durable: true });
  await channel.assertQueue(DEAD, { durable: true });
  await channel.bindQueue(DEAD, DLX, '');
}

function retentionArgs(spec: GroupSpec): Record<string, unknown> {
  const { maxLength, ttlMs } = spec.retention;

  return {
    ...(maxLength === undefined ? {} : { 'x-max-length': maxLength }),
    ...(ttlMs === undefined ? {} : { 'x-message-ttl': ttlMs }),
  };
}

function queueOptions(spec: GroupSpec): Options.AssertQueue {
  if (spec.exclusive) {
    return { exclusive: true, autoDelete: true, durable: false, arguments: retentionArgs(spec) };
  }

  return {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': DLX,
      ...(spec.quorum ? { 'x-queue-type': 'quorum' } : {}),
      ...retentionArgs(spec),
    },
  };
}

export async function assertGroup(channel: Channel, spec: GroupSpec): Promise<void> {
  await channel.assertQueue(spec.queue, queueOptions(spec));

  await Promise.all(
    [...new Set(spec.patterns)].map((pattern) => channel.bindQueue(spec.queue, EVENTS, pattern)),
  );
}

export async function assertRetry(channel: Channel, origin: string, route: RetryRoute): Promise<void> {
  await channel.assertQueue(route.queue, {
    durable: true,
    arguments: {
      'x-message-ttl': route.tier,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': origin,
    },
  });

  await channel.bindQueue(route.queue, RETRY, route.key);
}
