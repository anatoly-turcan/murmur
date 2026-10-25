import type { Envelope } from '../model/envelope.ts';

export interface Transport {
  readonly name: 'memory' | 'amqp' | (string & {});
  readonly features: TransportFeatures;
  publish(envelope: Envelope, options?: PublishOptions): Promise<void>;
  subscribe(
    patterns: readonly string[],
    group: string,
    handler: DeliveryHandler,
    options?: SubscribeOptions,
  ): Promise<Subscription>;
  close(signal?: AbortSignal): Promise<void>;
}

export interface TransportFeatures {
  readonly orderedWithinGroup: boolean;
  readonly detectsNoRoute: boolean;
  readonly nativeRedelivery: boolean;
  readonly directReply: boolean;
}

export interface PublishOptions {
  readonly mandatory?: boolean;
  readonly address?: string;
  readonly persistent?: boolean;
  readonly expiresMs?: number;
}

export interface SubscribeOptions {
  readonly prefetch: number;
  readonly exclusive?: boolean;
  readonly retention?: { maxLength?: number; ttlMs?: number };
  readonly signal?: AbortSignal;
}

export type DeliveryHandler = (delivery: TransportDelivery) => Promise<void>;

export interface TransportDelivery {
  readonly envelope: Envelope;
  readonly attempt: number;
  readonly redelivered: boolean;
  readonly replyAddress?: string;
  ack(): Promise<void>;
  nack(
    requeue: boolean,
    options?: { readonly delayMs?: number; readonly consumeAttempt?: boolean },
  ): Promise<void>;
}

export interface Subscription extends AsyncDisposable {
  readonly patterns: readonly string[];
  readonly group: string;
  unsubscribe(): Promise<void>;
}
