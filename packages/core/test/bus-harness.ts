import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { createMemoryTransport, type MemoryTransport } from '@murmur/transport-memory';
import {
  busContractOf,
  createBus,
  isInternal,
  type Bus,
  type BusContract,
  type BusOptions,
  type ContractClass,
  type Delivery,
  type DeliveryHandler,
  type Envelope,
  type InputOf,
  type LifecycleHook,
  type LogLine,
  type OutputOf,
  type PiecePolicy,
  type PiecePort,
  type PieceRuntime,
  type Registration,
  type Transport,
  type TransportDelivery,
} from 'murmur';
import { z } from 'zod';

export interface SpyTransport extends Transport {
  readonly inner: MemoryTransport;
  readonly published: Envelope[];
  readonly log: string[];
}

export type SysEnvelope = Envelope<Record<string, unknown>>;

function spyDelivery(delivery: TransportDelivery, log: string[]): TransportDelivery {
  const name = delivery.envelope.name;

  return {
    envelope: delivery.envelope,
    attempt: delivery.attempt,
    redelivered: delivery.redelivered,
    ack: async () => {
      log.push(`ack:${name}`);
      await delivery.ack();
    },
    nack: async (requeue, options) => {
      log.push(`nack:${name}:${requeue}`);
      await delivery.nack(requeue, options);
    },
  };
}

export function spy(inner: MemoryTransport, delayMs: (e: Envelope) => number = () => 0): SpyTransport {
  const published: Envelope[] = [];
  const log: string[] = [];

  return {
    name: inner.name,
    features: inner.features,
    inner,
    published,
    log,
    publish: async (envelope, options) => {
      published.push(envelope);
      const wait = delayMs(envelope);
      if (wait > 0) {
        await delay(wait);
      }

      await inner.publish(envelope, options);

      if (!isInternal(envelope.name)) {
        log.push(`published:${envelope.name}`);
      }
    },
    subscribe: (patterns, group, handler: DeliveryHandler, options) =>
      inner.subscribe(patterns, group, (d) => handler(spyDelivery(d, log)), options),
    close: (signal) => inner.close(signal),
  };
}

export interface Harness extends AsyncDisposable {
  readonly bus: Bus;
  readonly transport: SpyTransport;
  readonly memory: MemoryTransport;
  readonly lines: LogLine[];
  sys(name: string): SysEnvelope[];
  sysNames(): string[];
  add(id: string, spec: PieceSpec): Promise<Registration>;
}

export interface HandlerContext {
  readonly delivery: Delivery;
  readonly signal: AbortSignal;
  readonly port: PiecePort;
}

export interface HandlerSpec {
  readonly contract: BusContract;
  readonly handle: (input: unknown, context: HandlerContext) => unknown;
}

export interface PieceSpec {
  readonly on: readonly HandlerSpec[];
  readonly emits?: readonly ContractClass[];
  readonly policy?: PiecePolicy;
  readonly stop?: LifecycleHook;
}

export function on<C extends ContractClass>(
  contract: C,
  handle: (input: InputOf<C>, context: HandlerContext) => OutputOf<C> | Promise<OutputOf<C>>,
): HandlerSpec {
  return { contract: busContractOf(contract), handle: handle as HandlerSpec['handle'] };
}

export function onWire(name: string, handle: HandlerSpec['handle']): HandlerSpec {
  return { contract: { name, kind: 'event', payload: z.looseObject({}), reply: undefined }, handle };
}

const NO_PORT: PiecePort = {
  emit: () => Promise.reject(new Error('this runtime has no port')),
  request: () => Promise.reject(new Error('this runtime has no port')),
};

export interface HarnessOptions extends Partial<Omit<BusOptions, 'transport'>> {
  readonly delayMs?: (e: Envelope) => number;
}

export function runtimeOf(name: string, spec: PieceSpec, port: PiecePort = NO_PORT): PieceRuntime {
  return {
    name,
    handlers: spec.on.map(({ contract, handle }) => ({
      contract,
      handle: (input: unknown, delivery: Delivery) =>
        handle(input, { delivery, signal: delivery.signal, port }),
    })),
    emits: (spec.emits ?? []).map(busContractOf),
    policy: spec.policy ?? {},
    start: [],
    stop: spec.stop === undefined ? [] : [spec.stop],
  };
}

export function setup(options: HarnessOptions = {}): Harness {
  const { delayMs, ...busOptions } = options;
  const memory = createMemoryTransport();
  const transport = spy(memory, delayMs);
  const lines: LogLine[] = [];
  const bus = createBus({
    transport,
    context: new AsyncLocalStorage(),
    sink: (line) => lines.push(line),
    localRequests: false,
    ...busOptions,
  });
  const sys = (name: string) => transport.published.filter((e) => e.name === `$sys.${name}`) as SysEnvelope[];

  return {
    bus,
    transport,
    memory,
    lines,
    sys,
    sysNames: () => transport.published.filter((e) => isInternal(e.name)).map((e) => e.name.slice(5)),
    add: async (id, spec) => {
      const registration = await bus.register(runtimeOf(id, spec, bus.portFor(id)));
      await registration.start();

      return registration;
    },
    [Symbol.asyncDispose]: () => bus.stop('test', { graceMs: 200, forceMs: 200 }),
  };
}

export async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  if (predicate()) {
    return;
  }

  if (timeoutMs <= 0) {
    throw new Error('until: condition not met in time');
  }

  await delay(2);
  await until(predicate, timeoutMs - 2);
}

export function aborted(signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal.aborted) {
    resolve();
  }

  signal.addEventListener('abort', () => resolve(), { once: true });

  return promise;
}
