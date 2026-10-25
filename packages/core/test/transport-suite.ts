import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createEnvelope,
  EnvelopeShapeError,
  NoRouteError,
  parseEnvelope,
  serializeEnvelope,
  TransportError,
  type TransportDelivery,
  type DeliveryHandler,
  type Envelope,
  type Transport,
} from 'murmur';
import { fakeClock } from 'murmur/testing';

export type TransportFactory = () => Promise<Transport>;

const ids = { uuid: () => crypto.randomUUID(), short: () => crypto.randomUUID().slice(0, 8) };
const clock = fakeClock();
const WAIT_MS = 5_000;
const QUIET_MS = 150;

export function unique(prefix: string): string {
  return `${prefix}${crypto.randomUUID().slice(0, 8)}`;
}

export function envelope(name: string, payload: unknown = {}): Envelope {
  return createEnvelope({ name, payload, ids, clock });
}

async function withDeadline(work: Promise<void>, message: () => string): Promise<void> {
  const timer = new AbortController();
  const deadline = delay(WAIT_MS, undefined, { signal: timer.signal }).then(() => assert.fail(message()));

  try {
    await Promise.race([work, deadline]);
  } finally {
    timer.abort();
    await deadline.catch(() => undefined);
  }
}

export interface Inbox {
  readonly deliveries: TransportDelivery[];
  readonly handler: DeliveryHandler;
  waitFor(count: number): Promise<TransportDelivery[]>;
}

export function inbox(onDelivery: (delivery: TransportDelivery) => Promise<void> = (d) => d.ack()): Inbox {
  const deliveries: TransportDelivery[] = [];
  let waiters: { count: number; resolve: () => void }[] = [];
  const wake = () => {
    const ready = waiters.filter((w) => deliveries.length >= w.count);
    waiters = waiters.filter((w) => deliveries.length < w.count);

    for (const w of ready) {
      w.resolve();
    }
  };
  const handler: DeliveryHandler = async (delivery) => {
    deliveries.push(delivery);
    wake();
    await onDelivery(delivery);
  };
  const waitFor = async (count: number) => {
    if (deliveries.length < count) {
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ count, resolve });
      await withDeadline(promise, () => `expected ${count} deliveries, got ${deliveries.length}`);
    }

    return deliveries;
  };

  return { deliveries, handler, waitFor };
}

export async function withTransport(
  factory: TransportFactory,
  fn: (transport: Transport) => Promise<void>,
): Promise<void> {
  const transport = await factory();

  try {
    await fn(transport);
  } finally {
    await transport.close(AbortSignal.timeout(1_000));
  }
}

function countBy(deliveries: readonly TransportDelivery[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { envelope: e } of deliveries) {
    counts[e.name] = (counts[e.name] ?? 0) + 1;
  }

  return counts;
}

export function runTransportSuite(factory: TransportFactory): void {
  const run = (fn: (transport: Transport) => Promise<void>) => () => withTransport(factory, fn);

  describe('transport conformance', () => {
    test(
      'fans out one copy to each of three groups',
      run(async (t) => {
        const name = `${unique('suite')}.fanout`;
        const boxes = [inbox(), inbox(), inbox()];
        await Promise.all(boxes.map((box) => t.subscribe([name], unique('g'), box.handler)));
        await t.publish(envelope(name));
        await Promise.all(boxes.map((box) => box.waitFor(1)));
        await delay(QUIET_MS);
        assert.deepEqual(
          boxes.map((b) => b.deliveries.length),
          [1, 1, 1],
        );
      }),
    );

    test(
      'delivers one copy per group when two of its patterns match',
      run(async (t) => {
        const domain = unique('suite');
        const box = inbox();
        await t.subscribe([`${domain}.a`, `${domain}.*`], unique('g'), box.handler);
        await t.publish(envelope(`${domain}.a`));
        await box.waitFor(1);
        await delay(QUIET_MS);
        assert.equal(box.deliveries.length, 1);
      }),
    );

    test(
      'a group with [A, B] receives every A and B exactly once through its single handler',
      run(async (t) => {
        const domain = unique('suite');
        const box = inbox();
        await t.subscribe([`${domain}.a`, `${domain}.b`], unique('g'), box.handler);
        const sent = [
          ...Array.from({ length: 6 }, (_, i) => envelope(`${domain}.a`, { i })),
          ...Array.from({ length: 4 }, (_, i) => envelope(`${domain}.b`, { i })),
        ];
        await Promise.all(sent.map((e) => t.publish(e)));
        await box.waitFor(10);
        await delay(QUIET_MS);
        assert.deepEqual(countBy(box.deliveries), { [`${domain}.a`]: 6, [`${domain}.b`]: 4 });
        assert.equal(new Set(box.deliveries.map((d) => d.envelope.id)).size, 10);
      }),
    );

    test(
      'subscribing a group twice rejects with TransportError',
      run(async (t) => {
        const group = unique('g');
        await t.subscribe([`${unique('suite')}.a`], group, inbox().handler);
        await assert.rejects(t.subscribe([`${unique('suite')}.b`], group, inbox().handler), TransportError);
      }),
    );

    test(
      'publish never invokes a handler synchronously',
      run(async (t) => {
        const name = `${unique('suite')}.sync`;
        let called = false;
        const box = inbox(async (d) => {
          called = true;
          await d.ack();
        });
        await t.subscribe([name], unique('g'), box.handler);
        const published = t.publish(envelope(name));
        assert.equal(called, false);
        await published;
        await box.waitFor(1);
        assert.equal(called, true);
      }),
    );

    test(
      'delivers a fresh envelope equal to its JSON round-trip, attempt 1, not redelivered',
      run(async (t) => {
        const name = `${unique('suite')}.fresh`;
        const box = inbox();
        await t.subscribe([name], unique('g'), box.handler);
        const sent = envelope(name, { nested: { list: [1, 'two', null] } });
        await t.publish(sent);
        const [delivery] = await box.waitFor(1);
        assert.ok(delivery);
        assert.notEqual(delivery.envelope, sent);
        assert.deepEqual(delivery.envelope, parseEnvelope(serializeEnvelope(sent)));
        assert.equal(delivery.attempt, 1);
        assert.equal(delivery.redelivered, false);
      }),
    );

    test(
      'payloads follow JSON semantics: function key dropped, URL stringified, bigint rejected at publish',
      run(async (t) => {
        const name = `${unique('suite')}.json`;
        const box = inbox();
        await t.subscribe([name], unique('g'), box.handler);

        await t.publish(
          envelope(name, { fn: () => 1, url: new URL('https://example.test/a?b=1'), keep: true }),
        );

        const [delivery] = await box.waitFor(1);
        assert.deepEqual(delivery?.envelope.payload, { url: 'https://example.test/a?b=1', keep: true });
        await assert.rejects(t.publish(envelope(name, { n: 10n })), EnvelopeShapeError);
        await delay(QUIET_MS);
        assert.equal(box.deliveries.length, 1);
      }),
    );

    test(
      'nack(true, { delayMs }) redelivers to the same group after the delay with attempt + 1',
      run(async (t) => {
        const name = `${unique('suite')}.retry`;
        const delayMs = 100;
        let nackedAt = 0;
        const box = inbox(async (d) => {
          if (d.attempt > 1) {
            return d.ack();
          }

          nackedAt = performance.now();
          await d.nack(true, { delayMs });
        });
        await t.subscribe([name], unique('g'), box.handler);
        await t.publish(envelope(name));
        const [first, second] = await box.waitFor(2);
        const elapsed = performance.now() - nackedAt;
        assert.equal(first?.attempt, 1);
        assert.equal(second?.attempt, 2);
        assert.equal(second?.redelivered, false);
        assert.equal(second?.envelope.id, first?.envelope.id);
        assert.ok(elapsed >= delayMs - 5, `redelivered after ${elapsed} ms`);
      }),
    );

    test(
      'nack(true, { consumeAttempt: false }) redelivers with the same attempt and redelivered: true',
      run(async (t) => {
        const name = `${unique('suite')}.requeue`;
        const box = inbox(async (d) => (d.redelivered ? d.ack() : d.nack(true, { consumeAttempt: false })));
        await t.subscribe([name], unique('g'), box.handler);
        await t.publish(envelope(name));
        const [first, second] = await box.waitFor(2);
        assert.equal(first?.attempt, 1);
        assert.equal(second?.attempt, 1);
        assert.equal(second?.redelivered, true);
      }),
    );

    test(
      'nack(false) discards the delivery',
      run(async (t) => {
        const name = `${unique('suite')}.discard`;
        const box = inbox((d) => d.nack(false));
        await t.subscribe([name], unique('g'), box.handler);
        await t.publish(envelope(name));
        await box.waitFor(1);
        await delay(QUIET_MS);
        assert.equal(box.deliveries.length, 1);
      }),
    );

    test(
      'ack and nack are idempotent per delivery',
      run(async (t) => {
        const name = `${unique('suite')}.idempotent`;
        const box = inbox(async (d) => {
          await d.ack();
          await d.ack();
          await d.nack(true);
          await d.nack(false);
        });
        await t.subscribe([name], unique('g'), box.handler);
        await t.publish(envelope(name));
        await box.waitFor(1);
        await delay(QUIET_MS);
        assert.equal(box.deliveries.length, 1);
      }),
    );

    test(
      'mandatory publish with no binding rejects NoRouteError when the transport detects it',
      run(async (t) => {
        const unbound = t.publish(envelope(`${unique('suite')}.unbound`), { mandatory: true });
        if (t.features.detectsNoRoute) {
          await assert.rejects(unbound, NoRouteError);
        } else {
          await unbound;
        }

        const name = `${unique('suite')}.bound`;
        const box = inbox();
        await t.subscribe([name], unique('g'), box.handler);
        await t.publish(envelope(name), { mandatory: true });
        await box.waitFor(1);
      }),
    );

    test(
      'unsubscribe stops deliveries to that subscriber',
      run(async (t) => {
        const name = `${unique('suite')}.unsub`;
        const box = inbox();

        const subscription = await t.subscribe([name], unique('g'), box.handler, {
          prefetch: 1,
          exclusive: true,
        });

        assert.deepEqual(subscription.patterns, [name]);
        await t.publish(envelope(name));
        await box.waitFor(1);
        await subscription.unsubscribe();
        await subscription.unsubscribe();
        await t.publish(envelope(name));
        await delay(QUIET_MS);
        assert.equal(box.deliveries.length, 1);
      }),
    );

    test('close() drains in-flight deliveries before resolving', async () => {
      const transport = await factory();
      const name = `${unique('suite')}.drain`;
      const started = Promise.withResolvers<void>();
      let acked = false;
      const box = inbox(async (d) => {
        started.resolve();
        await delay(80);
        await d.ack();
        acked = true;
      });
      await transport.subscribe([name], unique('g'), box.handler);
      await transport.publish(envelope(name));
      await started.promise;
      await transport.close();
      assert.equal(acked, true);
      await transport.close();
    });

    test('close(signal) stops waiting for a stuck delivery when the signal aborts', async () => {
      const transport = await factory();
      const name = `${unique('suite')}.stuck`;
      const started = Promise.withResolvers<void>();
      const box = inbox(async () => started.resolve());
      await transport.subscribe([name], unique('g'), box.handler);
      await transport.publish(envelope(name));
      await started.promise;
      const begun = performance.now();
      await transport.close(AbortSignal.timeout(50));
      assert.ok(performance.now() - begun < 1_000);
    });
  });
}
