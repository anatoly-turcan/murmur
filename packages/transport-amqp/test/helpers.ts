import { createServer, connect as connectSocket, type Socket } from 'node:net';

import type { AmqpTransport, AmqpTransportOptions } from '@murmur/transport-amqp';
import { connect, type Channel } from 'amqplib';

import type { AmqpHooks } from '../src/options.ts';
import { createTransport } from '../src/transport.ts';

export const AMQP_URL = process.env['AMQP_URL'];
export const skip = AMQP_URL === undefined ? 'AMQP_URL not set' : false;

export function brokerUrl(): string {
  if (AMQP_URL === undefined) {
    throw new Error('AMQP_URL not set');
  }

  return AMQP_URL;
}

export async function withAmqp(
  options: Partial<AmqpTransportOptions>,
  fn: (t: AmqpTransport) => Promise<void>,
  hooks: AmqpHooks = {},
): Promise<void> {
  const transport = await createTransport({ url: brokerUrl(), ...options }, hooks);

  try {
    await fn(transport);
  } finally {
    await transport.close(AbortSignal.timeout(1_000));
  }
}

export interface QueueState {
  readonly exists: boolean;
  readonly messages: number;
  readonly consumers: number;
}

export async function queueState(queue: string): Promise<QueueState> {
  const connection = await connect(brokerUrl());

  try {
    const channel: Channel = await connection.createChannel();
    channel.on('error', () => undefined);
    const reply = await channel.checkQueue(queue);

    return { exists: true, messages: reply.messageCount, consumers: reply.consumerCount };
  } catch {
    return { exists: false, messages: 0, consumers: 0 };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

export async function queueExists(queue: string): Promise<{ exists: boolean; messages: number }> {
  const { exists, messages } = await queueState(queue);

  return { exists, messages };
}

export interface Proxy {
  readonly url: string;
  readonly upstreams: number;
  drop(): void;
  halfOpen(): void;
  close(): Promise<void>;
}

interface Pair {
  readonly client: Socket;
  readonly upstream: Socket;
  severed: boolean;
}

function pipePair(client: Socket, target: URL, pairs: Set<Pair>): void {
  const upstream = connectSocket(Number(target.port || 5672), target.hostname);
  const pair: Pair = { client, upstream, severed: false };
  pairs.add(pair);
  client.on('error', () => undefined);
  upstream.on('error', () => undefined);
  client.on('close', () => {
    if (!pair.severed) {
      upstream.destroy();
    }
  });
  upstream.on('close', () => {
    pairs.delete(pair);
    client.destroy();
  });
  client.pipe(upstream);
  upstream.pipe(client);
}

function sever(pair: Pair): void {
  pair.severed = true;
  pair.client.unpipe(pair.upstream);
  pair.upstream.unpipe(pair.client);
  pair.upstream.resume();
  pair.client.destroy();
}

export async function startProxy(): Promise<Proxy> {
  const target = new URL(brokerUrl());
  const pairs = new Set<Pair>();
  const server = createServer((client) => pipePair(client, target, pairs));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('proxy has no port');
  }

  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  const drop = () => {
    for (const pair of pairs) {
      pair.upstream.destroy();
    }
  };

  return {
    url: url.toString(),
    get upstreams() {
      return pairs.size;
    },
    drop,
    halfOpen: () => {
      for (const pair of pairs) {
        if (!pair.severed) {
          sever(pair);
        }
      }
    },
    close: async () => {
      drop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
