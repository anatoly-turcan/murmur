import type { Channel } from 'amqplib';

export interface AmqpHooks {
  readonly afterRetryConfirm?: (consumer: Channel) => Promise<void> | void;
}

export interface AmqpTransportOptions {
  readonly url: string;
  readonly instanceId?: string;
  readonly directReplyTo?: boolean;
  readonly quorum?: boolean;
  readonly heartbeatSec?: number;
  readonly publishBuffer?: number;
}

export interface ResolvedOptions {
  readonly url: string;
  readonly instanceId: string;
  readonly directReplyTo: boolean;
  readonly quorum: boolean;
  readonly heartbeatSec: number;
  readonly publishBuffer: number;
}

export function resolveOptions(options: AmqpTransportOptions): ResolvedOptions {
  return {
    url: options.url,
    instanceId: options.instanceId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 8),
    directReplyTo: options.directReplyTo ?? false,
    quorum: options.quorum ?? false,
    heartbeatSec: options.heartbeatSec ?? 30,
    publishBuffer: options.publishBuffer ?? 1_000,
  };
}

export function backoffMs(attempt: number): number {
  return Math.min(100 * 2 ** (attempt - 1), 5_000);
}
