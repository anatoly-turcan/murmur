import type { ConsumeMessage, Options } from 'amqplib';
import { serializeEnvelope, type Envelope, type PublishOptions } from 'murmur';

import { DIRECT_REPLY, EVENTS, RETRY, retryRoute, type RetryRoute } from './topology.ts';

export interface Outgoing {
  readonly name: string;
  readonly exchange: string;
  readonly key: string;
  readonly content: Buffer;
  readonly properties: Options.Publish & { readonly messageId: string };
}

export interface RetryMessage extends Outgoing {
  readonly route: RetryRoute | undefined;
}

function epochSeconds(ts: string): number {
  return Math.floor(Temporal.Instant.from(ts).epochMilliseconds / 1_000);
}

function replyToOf(envelope: Envelope, direct: boolean): Options.Publish {
  if (direct) {
    return { replyTo: DIRECT_REPLY };
  }

  return envelope.replyTo === undefined ? {} : { replyTo: envelope.replyTo };
}

export function eventMessage(envelope: Envelope, options: PublishOptions, direct: boolean): Outgoing {
  const content = Buffer.from(serializeEnvelope(envelope));
  const { address, expiresMs } = options;

  return {
    name: envelope.name,
    exchange: address === undefined ? EVENTS : '',
    key: address ?? envelope.name,
    content,
    properties: {
      contentType: 'application/json',
      messageId: envelope.id,
      timestamp: epochSeconds(envelope.ts),
      persistent: options.persistent ?? true,
      mandatory: options.mandatory ?? false,
      headers: { 'x-trace-id': envelope.traceId, 'x-hop': envelope.hop },
      ...(envelope.correlationId === undefined ? {} : { correlationId: envelope.correlationId }),
      ...replyToOf(envelope, direct),
      ...(expiresMs === undefined ? {} : { expiration: String(expiresMs) }),
    },
  };
}

export function attemptOf(message: ConsumeMessage): number {
  const attempt = Number(message.properties.headers?.['x-attempt'] ?? 1);

  return Number.isInteger(attempt) && attempt >= 1 ? attempt : 1;
}

function carriedProperties(message: ConsumeMessage): Options.Publish {
  const { contentType, timestamp, correlationId, replyTo, deliveryMode, headers } = message.properties;
  const carried: Record<string, unknown> = {
    contentType,
    timestamp,
    correlationId,
    replyTo,
    persistent: deliveryMode === 2,
    headers: { 'x-trace-id': headers?.['x-trace-id'], 'x-hop': headers?.['x-hop'] },
  };

  return Object.fromEntries(Object.entries(carried).filter(([, value]) => value !== undefined));
}

export function retryMessage(
  message: ConsumeMessage,
  name: string,
  queue: string,
  delayMs: number,
): RetryMessage {
  const route = delayMs > 0 ? retryRoute(queue, delayMs) : undefined;
  const properties = carriedProperties(message);

  return {
    name,
    route,
    exchange: route === undefined ? '' : RETRY,
    key: route?.key ?? queue,
    content: message.content,
    properties: {
      ...properties,
      messageId: String(message.properties.messageId),
      mandatory: true,
      headers: { ...properties.headers, 'x-attempt': attemptOf(message) + 1 },
    },
  };
}
