import {
  NoRouteError,
  parseEnvelope,
  serializeEnvelope,
  TransportError,
  type TransportDelivery,
  type DeliveryHandler,
  type Envelope,
  type PublishOptions,
  type SubscribeOptions,
  type Subscription,
  type Transport,
  type TransportFeatures,
} from 'murmur';

import { chaosFates, type ChaosOptions } from './chaos.ts';
import {
  attach,
  createGroup,
  detach,
  enqueue,
  isSettled,
  matches,
  nextDue,
  stopWake,
  takeReady,
  wakeAt,
  type Group,
  type InFlight,
  type Item,
} from './group.ts';

export interface MemoryTransportOptions {
  latencyMs?: number;
  chaos?: ChaosOptions;
}

export interface DeadLetter {
  readonly envelope: Envelope;
  readonly group: string;
  readonly attempt: number;
}

export interface MemoryStats {
  readonly published: number;
  readonly delivered: number;
  readonly acked: number;
  readonly nacked: number;
  readonly queued: number;
  readonly inflight: number;
}

export interface MemoryTransport extends Transport {
  idle(): Promise<void>;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  readonly deadLetters: ReadonlyArray<DeadLetter>;
  readonly stats: MemoryStats;
  inject(envelope: Envelope, group: string, options?: { attempt?: number; redelivered?: boolean }): void;
}

type NackOptions = Parameters<TransportDelivery['nack']>[1];

const FEATURES: TransportFeatures = {
  orderedWithinGroup: true,
  detectsNoRoute: true,
  nativeRedelivery: false,
  directReply: false,
};

function untilSettledOrAborted(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return work.then(() => undefined);
  }

  if (signal.aborted) {
    return Promise.resolve();
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  signal.addEventListener('abort', () => resolve(), { once: true });
  void work.then(() => resolve());

  return promise;
}

async function invoke(handler: DeliveryHandler, delivery: TransportDelivery): Promise<void> {
  try {
    await handler(delivery);
  } catch {
    await delivery.nack(true);
  }
}

export function createMemoryTransport(options: MemoryTransportOptions = {}): MemoryTransport {
  const latencyMs = options.latencyMs ?? 0;
  const nextFate = chaosFates(options.chaos);
  const groups = new Map<string, Group>();
  const deadLetters: DeadLetter[] = [];
  const counters = { published: 0, delivered: 0, acked: 0, nacked: 0 };
  let idleWaiters: (() => void)[] = [];
  let paused = false;
  let closing: Promise<void> | undefined;

  const sum = (count: (group: Group) => number) =>
    [...groups.values()].reduce((total, g) => total + count(g), 0);
  const isLive = (group: Group) => groups.get(group.name) === group;

  function assertOpen(): void {
    if (closing !== undefined) {
      throw new TransportError('memory transport is closed', { retryable: false });
    }
  }

  function notifyIdle(): void {
    if (![...groups.values()].every(isSettled)) {
      return;
    }

    const waiters = idleWaiters;
    idleWaiters = [];

    for (const resolve of waiters) {
      resolve();
    }
  }

  function schedule(group: Group, at: number): void {
    if (closing !== undefined || paused || group.handler === undefined) {
      return;
    }

    wakeAt(group, at, performance.now(), () => pump(group));
  }

  function offer(
    group: Group,
    bytes: string,
    item: Partial<Item> & { expiresMs?: number | undefined },
  ): void {
    const now = performance.now();
    const queued: Item = {
      bytes,
      attempt: item.attempt ?? 1,
      redelivered: item.redelivered ?? false,
      notBefore: item.notBefore ?? now + latencyMs,
      expiresAt: item.expiresAt ?? now + Math.min(item.expiresMs ?? Infinity, group.ttlMs),
    };
    enqueue(group, queued);
    schedule(group, queued.notBefore);
  }

  function onNack(group: Group, item: Item, requeue: boolean, nack: NackOptions = {}): void {
    counters.nacked++;

    if (!requeue) {
      deadLetters.push({ envelope: parseEnvelope(item.bytes), group: group.name, attempt: item.attempt });

      return;
    }

    if (!isLive(group)) {
      return;
    }

    const consumeAttempt = nack.consumeAttempt ?? true;
    offer(group, item.bytes, {
      ...item,
      attempt: item.attempt + (consumeAttempt ? 1 : 0),
      redelivered: !consumeAttempt,
      notBefore: performance.now() + (nack.delayMs ?? 0),
    });
  }

  function deliver(group: Group, handler: DeliveryHandler, item: Item): void {
    const { promise: done, resolve } = Promise.withResolvers<void>();
    let settled = false;
    const settle = (effect: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      group.inflight.delete(flight);
      effect();
      resolve();
      schedule(group, performance.now());
      notifyIdle();
    };
    const flight: InFlight = {
      done,
      requeue: () =>
        settle(() => enqueue(group, { ...item, redelivered: true, notBefore: performance.now() })),
    };
    const delivery: TransportDelivery = {
      envelope: parseEnvelope(item.bytes),
      attempt: item.attempt,
      redelivered: item.redelivered,
      ack: async () => settle(() => counters.acked++),
      nack: async (requeue, nack) => settle(() => onNack(group, item, requeue, nack)),
    };
    group.inflight.add(flight);
    counters.delivered++;
    void invoke(handler, delivery);
  }

  function pump(group: Group): void {
    const handler = group.handler;
    if (closing !== undefined || paused || handler === undefined) {
      return;
    }

    const now = performance.now();
    while (group.inflight.size < group.prefetch) {
      const item = takeReady(group, now);
      if (item === undefined) {
        break;
      }

      deliver(group, handler, item);
    }

    const due = nextDue(group);
    if (due !== undefined && group.inflight.size < group.prefetch) {
      schedule(group, due);
    }

    notifyIdle();
  }

  async function publish(envelope: Envelope, publishOptions: PublishOptions = {}): Promise<void> {
    assertOpen();
    const bytes = serializeEnvelope(envelope);
    const targets = [...groups.values()].filter((group) => matches(group, envelope.name));

    if (publishOptions.mandatory === true && targets.length === 0) {
      throw new NoRouteError(envelope.name);
    }

    counters.published++;
    const fate = nextFate();
    if (fate === 'drop') {
      return;
    }

    for (const group of targets) {
      offer(group, bytes, { expiresMs: publishOptions.expiresMs });

      if (fate === 'duplicate') {
        offer(group, bytes, { expiresMs: publishOptions.expiresMs, redelivered: true });
      }
    }
  }

  function unsubscriber(group: Group, owner: object): () => Promise<void> {
    return async () => {
      if (group.owner !== owner) {
        return;
      }

      detach(group);

      if (group.exclusive) {
        groups.delete(group.name);
      }

      notifyIdle();
    };
  }

  async function subscribe(
    patterns: readonly string[],
    name: string,
    handler: DeliveryHandler,
    subscribeOptions: SubscribeOptions = { prefetch: 1 },
  ): Promise<Subscription> {
    assertOpen();
    subscribeOptions.signal?.throwIfAborted();
    const group = groups.get(name) ?? createGroup(name);
    if (group.handler !== undefined) {
      throw new TransportError(`group already subscribed: ${name}`);
    }

    const owner = attach(group, patterns, handler, subscribeOptions);
    groups.set(name, group);
    schedule(group, performance.now());
    const unsubscribe = unsubscriber(group, owner);
    subscribeOptions.signal?.addEventListener('abort', () => void unsubscribe(), { once: true });

    return { patterns: group.patterns, group: name, unsubscribe, [Symbol.asyncDispose]: unsubscribe };
  }

  async function shutdown(signal: AbortSignal | undefined): Promise<void> {
    for (const group of groups.values()) {
      stopWake(group);
    }

    const done: Promise<void>[] = [];
    for (const group of groups.values()) {
      for (const flight of group.inflight) {
        done.push(flight.done);
      }
    }

    await untilSettledOrAborted(Promise.allSettled(done), signal);

    for (const group of groups.values()) {
      for (const flight of group.inflight) {
        flight.requeue();
      }

      detach(group);
    }

    notifyIdle();
  }

  function inject(
    envelope: Envelope,
    name: string,
    injectOptions: { attempt?: number; redelivered?: boolean } = {},
  ): void {
    const group = groups.get(name);
    if (group === undefined) {
      throw new TransportError(`unknown group: ${name}`, { retryable: false });
    }

    offer(group, serializeEnvelope(envelope), injectOptions);
  }

  function idle(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    idleWaiters.push(resolve);
    notifyIdle();

    return promise;
  }

  const stats: MemoryStats = {
    get published() {
      return counters.published;
    },
    get delivered() {
      return counters.delivered;
    },
    get acked() {
      return counters.acked;
    },
    get nacked() {
      return counters.nacked;
    },
    get queued() {
      return sum((group) => group.queue.length);
    },
    get inflight() {
      return sum((group) => group.inflight.size);
    },
  };

  return {
    name: 'memory',
    features: FEATURES,
    publish,
    subscribe,
    close: (signal) => (closing ??= shutdown(signal)),
    idle,
    pause: () => {
      paused = true;

      for (const group of groups.values()) {
        stopWake(group);
      }
    },
    resume: () => {
      paused = false;

      for (const group of groups.values()) {
        schedule(group, performance.now());
      }
    },
    get paused() {
      return paused;
    },
    deadLetters,
    stats,
    inject,
  };
}
