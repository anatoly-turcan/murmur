import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createMemoryTransport,
  type MemoryTransport,
  type MemoryTransportOptions,
} from '@murmur/transport-memory';
import { TransportError } from 'murmur';

import { envelope, inbox } from '../../core/test/transport-suite.ts';

async function withMemory(
  options: MemoryTransportOptions,
  fn: (t: MemoryTransport) => Promise<void>,
): Promise<void> {
  const transport = createMemoryTransport(options);

  try {
    await fn(transport);
  } finally {
    await transport.close(AbortSignal.timeout(500));
  }
}

function publishAll(t: MemoryTransport, name: string, payloads: readonly unknown[]): Promise<void[]> {
  return Promise.all(payloads.map((payload) => t.publish(envelope(name, payload))));
}

test('features describe the memory transport', () => {
  const transport = createMemoryTransport();
  assert.equal(transport.name, 'memory');
  assert.deepEqual(transport.features, {
    orderedWithinGroup: true,
    detectsNoRoute: true,
    nativeRedelivery: false,
    directReply: false,
  });
});

test('nack(false) lands in deadLetters with group and attempt', () =>
  withMemory({}, async (t) => {
    const box = inbox((d) => (d.attempt < 2 ? d.nack(true) : d.nack(false)));
    await t.subscribe(['a.dead'], 'billing/invoice', box.handler);
    const sent = envelope('a.dead', { x: 1 });
    await t.publish(sent);
    await box.waitFor(2);
    await t.idle();
    assert.equal(t.deadLetters.length, 1);
    assert.deepEqual(t.deadLetters[0], {
      envelope: JSON.parse(JSON.stringify(sent)),
      group: 'billing/invoice',
      attempt: 2,
    });
  }));

test('chaos.duplicateEvery delivers every n-th publish twice, the copy redelivered', () =>
  withMemory({ chaos: { duplicateEvery: 2 } }, async (t) => {
    const box = inbox();
    await t.subscribe(['a.dup'], 'g', box.handler);
    await t.publish(envelope('a.dup', 1));
    await t.publish(envelope('a.dup', 2));
    await box.waitFor(3);
    await t.idle();
    assert.deepEqual(
      box.deliveries.map((d) => [d.envelope.payload, d.redelivered]),
      [
        [1, false],
        [2, false],
        [2, true],
      ],
    );
    assert.equal(box.deliveries[2]?.envelope.id, box.deliveries[1]?.envelope.id);
  }));

test('chaos.dropEvery loses every n-th publish', () =>
  withMemory({ chaos: { dropEvery: 3 } }, async (t) => {
    const box = inbox();
    await t.subscribe(['a.drop'], 'g', box.handler);
    await publishAll(t, 'a.drop', [1, 2, 3, 4, 5, 6]);
    await t.idle();
    assert.deepEqual(
      box.deliveries.map((d) => d.envelope.payload),
      [1, 2, 4, 5],
    );
    assert.equal(t.stats.published, 6);
  }));

test('pause() holds deliveries and resume() releases them in order', () =>
  withMemory({}, async (t) => {
    const box = inbox();
    await t.subscribe(['a.pause'], 'g', box.handler);
    t.pause();
    assert.equal(t.paused, true);
    await publishAll(t, 'a.pause', [1, 2, 3]);
    await delay(30);
    assert.equal(box.deliveries.length, 0);
    assert.equal(t.stats.queued, 3);
    t.resume();
    assert.equal(t.paused, false);
    await t.idle();
    assert.deepEqual(
      box.deliveries.map((d) => d.envelope.payload),
      [1, 2, 3],
    );
  }));

test('idle() waits for queued, delayed and in-flight deliveries', () =>
  withMemory({}, async (t) => {
    const box = inbox(async (d) => (d.attempt === 1 ? d.nack(true, { delayMs: 40 }) : d.ack()));
    await t.subscribe(['a.idle'], 'g', box.handler);
    await t.idle();
    await t.publish(envelope('a.idle'));
    await t.idle();
    assert.equal(box.deliveries.length, 2);
    assert.deepEqual(
      { ...t.stats },
      { published: 1, delivered: 2, acked: 1, nacked: 1, queued: 0, inflight: 0 },
    );
  }));

test('prefetch bounds in-flight deliveries per group', () =>
  withMemory({}, async (t) => {
    let inflight = 0;
    let peak = 0;
    const box = inbox(async (d) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await delay(5);
      inflight--;
      await d.ack();
    });
    await t.subscribe(['a.prefetch'], 'g', box.handler, { prefetch: 3 });

    await publishAll(
      t,
      'a.prefetch',
      Array.from({ length: 10 }, (_, i) => i),
    );

    await t.idle();
    assert.equal(box.deliveries.length, 10);
    assert.equal(peak, 3);
  }));

test('inject() delivers an envelope to one group with the given attempt', () =>
  withMemory({}, async (t) => {
    const box = inbox();
    await t.subscribe(['a.inject'], 'g', box.handler);
    t.inject(envelope('a.other'), 'g', { attempt: 3, redelivered: true });
    const [delivery] = await box.waitFor(1);
    assert.equal(delivery?.attempt, 3);
    assert.equal(delivery?.redelivered, true);
    assert.throws(() => t.inject(envelope('a.inject'), 'missing'), TransportError);
  }));

test('latencyMs delays every delivery', () =>
  withMemory({ latencyMs: 40 }, async (t) => {
    const box = inbox();
    await t.subscribe(['a.latency'], 'g', box.handler);
    const begun = performance.now();
    await t.publish(envelope('a.latency'));
    await box.waitFor(1);
    assert.ok(performance.now() - begun >= 35);
  }));

test('a durable group keeps its queue across unsubscribe; an exclusive group drops it', () =>
  withMemory({}, async (t) => {
    const durable = await t.subscribe(['a.keep'], 'durable', inbox().handler);

    const exclusive = await t.subscribe(['a.keep'], 'exclusive', inbox().handler, {
      prefetch: 1,
      exclusive: true,
    });

    await durable.unsubscribe();
    await exclusive.unsubscribe();
    await t.publish(envelope('a.keep'));
    const box = inbox();
    await t.subscribe(['a.keep'], 'durable', box.handler);
    await box.waitFor(1);
    await assert.rejects(t.publish(envelope('a.gone'), { mandatory: true }));
  }));

test('retention.maxLength keeps the newest items and expiresMs drops stale ones', () =>
  withMemory({}, async (t) => {
    const box = inbox();

    await t.subscribe(['a.ret'], 'obs', box.handler, {
      prefetch: 1,
      exclusive: true,
      retention: { maxLength: 2 },
    });

    t.pause();
    await publishAll(t, 'a.ret', [1, 2, 3, 4]);
    await t.publish(envelope('a.ret', 'stale'), { expiresMs: 10 });
    await delay(30);
    t.resume();
    await t.idle();
    assert.deepEqual(
      box.deliveries.map((d) => d.envelope.payload),
      [4],
    );
  }));

test('subscribe signal unsubscribes on abort', () =>
  withMemory({}, async (t) => {
    const controller = new AbortController();
    const box = inbox();

    await t.subscribe(['a.signal'], 'g', box.handler, {
      prefetch: 1,
      exclusive: true,
      signal: controller.signal,
    });

    controller.abort();
    await t.publish(envelope('a.signal'));
    await t.idle();
    assert.equal(box.deliveries.length, 0);
  }));

test('publish and subscribe reject after close', async () => {
  const t = createMemoryTransport();
  await t.close();
  await assert.rejects(t.publish(envelope('a.closed')), TransportError);
  await assert.rejects(t.subscribe(['a.closed'], 'g', inbox().handler), TransportError);
});
