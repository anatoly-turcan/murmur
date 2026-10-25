import { setTimeout as delay } from 'node:timers/promises';

import { connect, type ChannelModel, type ConfirmChannel, type Message } from 'amqplib';
import { TransportError } from 'murmur';

import { backoffMs, type ResolvedOptions } from './options.ts';
import { assertBase } from './topology.ts';

export interface Link {
  readonly connection: ChannelModel;
  readonly publisher: ConfirmChannel;
  alive: boolean;
}

export interface SessionHooks {
  readonly onReturn: (message: Message) => void;
  readonly onDown: (error: unknown) => void;
  readonly onUp: (link: Link) => Promise<void>;
  readonly onLive: (link: Link, attempt: number) => void;
}

export interface Session {
  readonly link: Link | undefined;
  ready(): Promise<Link>;
  start(): Promise<void>;
  close(): Promise<void>;
}

const ignore = () => undefined;

function connectUrl(options: ResolvedOptions): string {
  const url = new URL(options.url);
  if (!url.searchParams.has('heartbeat')) {
    url.searchParams.set('heartbeat', String(options.heartbeatSec));
  }

  return url.toString();
}

function pending(): PromiseWithResolvers<Link> {
  const resolvers = Promise.withResolvers<Link>();
  resolvers.promise.catch(ignore);

  return resolvers;
}

export function createSession(options: ResolvedOptions, hooks: SessionHooks): Session {
  const stopping = new AbortController();
  let link: Link | undefined;
  let waiting = pending();

  async function prepare(connection: ChannelModel): Promise<Link> {
    const publisher = await connection.createConfirmChannel();
    const next: Link = { connection, publisher, alive: true };
    publisher.on('error', ignore);
    publisher.on('return', hooks.onReturn);
    connection.on('close', (error?: Error) => lost(next, error));
    publisher.on('close', () => lost(next, new TransportError('amqp publish channel closed')));
    await assertBase(publisher);

    return next;
  }

  async function open(): Promise<Link> {
    const connection = await connect(connectUrl(options), {
      clientProperties: { connection_name: `murmur:${options.instanceId}` },
    });

    connection.on('error', ignore);

    try {
      return await prepare(connection);
    } catch (error) {
      await connection.close().catch(ignore);
      throw error;
    }
  }

  function goLive(next: Link, attempt: number): void {
    link = next;
    waiting.resolve(next);
    hooks.onLive(next, attempt);
  }

  function lost(dead: Link, error: unknown): void {
    if (!dead.alive) {
      return;
    }

    dead.alive = false;
    void dead.connection.close().catch(ignore);

    if (link !== dead) {
      return;
    }

    link = undefined;
    waiting = pending();

    if (stopping.signal.aborted) {
      return;
    }

    hooks.onDown(error);
    void reconnect();
  }

  async function discard(next: Link): Promise<undefined> {
    next.alive = false;
    await next.connection.close().catch(ignore);
  }

  async function attemptReconnect(): Promise<Link | undefined> {
    const next = await open().catch(ignore);
    if (next === undefined) {
      return undefined;
    }

    const up = await hooks.onUp(next).then(
      () => next.alive,
      () => false,
    );

    return up ? next : discard(next);
  }

  async function reconnect(attempt = 1): Promise<void> {
    const slept = await delay(backoffMs(attempt), true, { signal: stopping.signal }).catch(() => false);
    if (!slept) {
      return;
    }

    const next = await attemptReconnect();
    if (next === undefined) {
      return reconnect(attempt + 1);
    }

    if (stopping.signal.aborted) {
      await next.connection.close().catch(ignore);
    } else {
      goLive(next, attempt);
    }
  }

  async function start(): Promise<void> {
    try {
      goLive(await open(), 0);
    } catch (cause) {
      throw new TransportError(`amqp connect failed: ${String(cause)}`, { cause });
    }
  }

  async function close(): Promise<void> {
    stopping.abort();
    waiting.reject(new TransportError('amqp transport is closed', { retryable: false }));
    const current = link;
    link = undefined;

    if (current === undefined) {
      return;
    }

    current.alive = false;
    await current.connection.close().catch(ignore);
  }

  return {
    get link() {
      return link;
    },
    ready: () => (link === undefined ? waiting.promise : Promise.resolve(link)),
    start,
    close,
  };
}
