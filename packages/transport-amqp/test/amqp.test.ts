import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createAmqpTransport } from '@murmur/transport-amqp';
import { connect } from 'amqplib';
import { Command, createBus, NoRouteError, serializeEnvelope, type Bus } from 'murmur';
import { z } from 'zod';

import { on, runtimeOf, type PieceSpec } from '../../core/test/bus-harness.ts';
import { envelope, inbox, unique } from '../../core/test/transport-suite.ts';
import { brokerUrl, queueExists, queueState, skip, startProxy, withAmqp } from './helpers.ts';

test('features describe the amqp transport', { skip }, () =>
  withAmqp({}, async (t) => {
    assert.equal(t.name, 'amqp');
    assert.deepEqual(t.features, {
      orderedWithinGroup: true,
      detectsNoRoute: true,
      nativeRedelivery: true,
      directReply: true,
    });
  }),
);

test('a delayed retry lands in its tier queue and returns with x-attempt incremented', { skip }, () =>
  withAmqp({}, async (t) => {
    const name = `${unique('amqp')}.tier`;
    const group = unique('g');
    const parked = Promise.withResolvers<void>();
    let nackedAt = 0;
    const box = inbox(async (d) => {
      if (d.attempt > 1) {
        return d.ack();
      }

      nackedAt = performance.now();
      await d.nack(true, { delayMs: 600 });
      parked.resolve();
    });
    await t.subscribe([name], group, box.handler);
    await t.publish(envelope(name));
    await parked.promise;
    assert.deepEqual(await queueExists(`murmur.retry.murmur.q.${group}.1000`), { exists: true, messages: 1 });
    assert.equal((await queueExists(`murmur.retry.murmur.q.${group}.250`)).exists, false);
    const [first, second] = await box.waitFor(2);
    assert.equal(first?.attempt, 1);
    assert.equal(second?.attempt, 2);
    assert.equal(second?.redelivered, false);
    assert.equal(second?.envelope.id, first?.envelope.id);
    assert.ok(performance.now() - nackedAt >= 950);
  }),
);

test('killing the channel between the retry publish and the ack redelivers the original', { skip }, () => {
  let killed = false;

  return withAmqp(
    {},
    async (t) => {
      const name = `${unique('amqp')}.kill`;
      const box = inbox(async (d) => {
        if (d.attempt === 1 && !d.redelivered) {
          return d.nack(true, { delayMs: 100 });
        }

        await d.ack();
      });
      await t.subscribe([name], unique('g'), box.handler);
      const sent = envelope(name);
      await t.publish(sent);
      const deliveries = await box.waitFor(3);
      assert.equal(killed, true);
      assert.ok(deliveries.every((d) => d.envelope.id === sent.id));
      assert.ok(deliveries.some((d) => d.attempt === 1 && d.redelivered));
      assert.ok(deliveries.some((d) => d.attempt === 2 && !d.redelivered));
    },
    {
      afterRetryConfirm: async (channel) => {
        if (killed) {
          return;
        }

        killed = true;
        await channel.close();
      },
    },
  );
});

async function deleteQueue(queue: string): Promise<void> {
  const connection = await connect(brokerUrl());

  try {
    const channel = await connection.createChannel();
    await channel.deleteQueue(queue);
  } finally {
    await connection.close();
  }
}

test('a retry whose tier queue vanished is requeued, not lost', { skip }, () =>
  withAmqp({}, async (t) => {
    const name = `${unique('amqp')}.vanished`;
    const group = unique('g');
    const box = inbox(async (d) => (d.attempt > 1 ? d.ack() : d.nack(true, { delayMs: 100 })));
    await t.subscribe([name], group, box.handler);
    await t.publish(envelope(name));
    await box.waitFor(2);
    await deleteQueue(`murmur.retry.murmur.q.${group}.250`);
    const sent = envelope(name);
    await t.publish(sent);
    const deliveries = await box.waitFor(5);
    const again = deliveries.slice(2);
    assert.ok(again.every((d) => d.envelope.id === sent.id));
    assert.deepEqual(
      again.map((d) => [d.attempt, d.redelivered]),
      [
        [1, false],
        [1, true],
        [2, false],
      ],
    );
  }),
);

test('many unsettled deliveries on one channel add no close listeners each', { skip }, () =>
  withAmqp({}, async (t) => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on('warning', onWarning);

    try {
      const name = `${unique('amqp')}.held`;
      const held: (() => Promise<void>)[] = [];
      const box = inbox(async (d) => void held.push(() => d.ack()));
      await t.subscribe([name], unique('g'), box.handler, { prefetch: 20 });
      await Promise.all(Array.from({ length: 20 }, () => t.publish(envelope(name))));
      await box.waitFor(20);
      await Promise.all(held.map((ack) => ack()));
      await delay(50);
      assert.deepEqual(
        warnings.filter((w) => w.name === 'MaxListenersExceededWarning'),
        [],
      );
    } finally {
      process.off('warning', onWarning);
    }
  }),
);

test('a mandatory publish with no binding rejects NoRouteError via basic.return', { skip }, () =>
  withAmqp({}, async (t) => {
    const name = `${unique('amqp')}.unbound`;
    await assert.rejects(t.publish(envelope(name), { mandatory: true }), NoRouteError);
    await t.publish(envelope(name));
  }),
);

test(
  'killing the connection publishes transport.reconnecting/reconnected and redelivers unacked messages',
  { skip },
  async () => {
    const proxy = await startProxy();
    const t = await createAmqpTransport({ url: proxy.url });

    try {
      const status = inbox();

      await t.subscribe(['$sys.transport.#'], `$observer.${unique('t')}.x`, status.handler, {
        prefetch: 64,
        exclusive: true,
      });

      const name = `${unique('amqp')}.reconnect`;
      const held = Promise.withResolvers<void>();
      const box = inbox(async (d) => {
        if (d.redelivered) {
          return d.ack();
        }

        held.resolve();
      });
      await t.subscribe([name], unique('g'), box.handler);
      const sent = envelope(name);
      await t.publish(sent);
      await held.promise;
      proxy.drop();
      const [, again] = await box.waitFor(2);
      assert.equal(again?.envelope.id, sent.id);
      assert.equal(again?.redelivered, true);
      assert.equal(again?.attempt, 1);
      const events = await status.waitFor(2);
      assert.deepEqual(
        events.map((d) => d.envelope.name),
        ['$sys.transport.reconnecting', '$sys.transport.reconnected'],
      );
      const payload = events[0]?.envelope.payload as { transport: string } | undefined;
      assert.equal(payload?.transport, 'amqp');
    } finally {
      await t.close(AbortSignal.timeout(1_000));
      await proxy.close();
    }
  },
);

async function eventually(check: () => boolean, deadline = performance.now() + 15_000): Promise<void> {
  if (check()) {
    return;
  }

  assert.ok(performance.now() < deadline, 'condition not met in time');
  await delay(50);
  await eventually(check, deadline);
}

async function publishRaw(name: string, count: number): Promise<void> {
  const connection = await connect(brokerUrl());

  try {
    const channel = await connection.createConfirmChannel();
    for (let i = 0; i < count; i++) {
      channel.publish('murmur.events', name, Buffer.from(serializeEnvelope(envelope(name))));
    }

    await channel.waitForConfirms();
  } finally {
    await connection.close();
  }
}

test(
  'a half-open connection loss reconnects without leaking connections or consumers',
  { skip },
  async () => {
    const proxy = await startProxy();
    const url = new URL(proxy.url);
    url.searchParams.set('heartbeat', '1');
    const t = await createAmqpTransport({ url: url.toString() });
    const name = `${unique('amqp')}.halfopen`;
    const queue = `murmur.q.${unique('g')}`;
    const status = inbox();
    const box = inbox();

    try {
      await t.subscribe(['$sys.transport.#'], `$observer.${unique('t')}.x`, status.handler, {
        prefetch: 64,
        exclusive: true,
      });

      await t.subscribe([name], queue.slice('murmur.q.'.length), box.handler);
      proxy.halfOpen();
      await eventually(() => status.deliveries.length >= 2);
      const reconnected = status.deliveries[1]?.envelope;
      assert.equal(reconnected?.name, '$sys.transport.reconnected');
      assert.ok((reconnected.payload as { attempt: number }).attempt > 1);
      assert.equal(proxy.upstreams, 1);
      assert.equal((await queueState(queue)).consumers, 1);
      await t.publish(envelope(name));
      await box.waitFor(1);
    } finally {
      await t.close(AbortSignal.timeout(1_000));
      await proxy.close();
    }

    await publishRaw(name, 3);
    await delay(300);
    assert.equal(box.deliveries.length, 1);
    assert.deepEqual(await queueState(queue), { exists: true, messages: 3, consumers: 0 });
  },
);

class Add extends Command({ a: z.number(), b: z.number() }, { sum: z.number() }, { name: 'amqp.math.add' }) {}

const adder: PieceSpec = { on: [on(Add, ({ a, b }) => ({ sum: a + b }))] };

async function amqpBus(options: { directReplyTo?: boolean } = {}): Promise<Bus> {
  const transport = await createAmqpTransport({ url: brokerUrl(), ...options });

  return createBus({ transport, context: new AsyncLocalStorage(), sink: () => undefined });
}

test('directReplyTo: true round-trips a request through amq.rabbitmq.reply-to', { skip }, async () => {
  const responder = await amqpBus();
  const requester = await amqpBus({ directReplyTo: true });

  try {
    const registration = await responder.register(runtimeOf(unique('math'), adder));
    await registration.start();
    assert.deepEqual(await requester.request(Add, { a: 2, b: 3 }), { sum: 5 });
    assert.equal((await queueExists(`murmur.reply.${requester.instanceId}`)).exists, false);
  } finally {
    await requester.stop('test', { graceMs: 200, forceMs: 500 });
    await responder.stop('test', { graceMs: 200, forceMs: 500 });
  }
});
