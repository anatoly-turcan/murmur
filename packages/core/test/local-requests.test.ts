import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createBus } from 'murmur';

import { on, setup, until } from './bus-harness.ts';
import { CreateTodo, GetTodo } from './fixtures/v2/contracts/todos.ts';

function overTransport(names: readonly string[]): string[] {
  return names.filter((name) => name === GetTodo.wireName || name.startsWith('$reply.'));
}

test('a request to a locally handled contract makes no transport call and still emits $sys.request.*', async () => {
  await using h = setup({ localRequests: true });
  await h.add('store', { on: [on(GetTodo, (input) => ({ id: input.id, title: 'milk', done: false }))] });
  const todo = await h.bus.request(GetTodo, { id: 't1' });
  await until(() => h.sys('delivery.acked').length === 1);
  const published = h.sys('event.published').map((e) => e.payload);

  assert.deepEqual(todo, { id: 't1', title: 'milk', done: false });
  assert.deepEqual(overTransport(h.transport.published.map((e) => e.name)), []);
  assert.equal(h.sys('request.sent').length, 1);
  assert.equal(h.sys('request.completed')[0]?.payload['ok'], true);
  assert.equal(h.sys('delivery.acked')[0]?.payload['replied'], true);
  assert.deepEqual(
    published.map((p) => [p['name'], p['local']]),
    [
      [GetTodo.wireName, true],
      [`$reply.${h.bus.instanceId}`, true],
    ],
  );
});

test('a local handler that throws is retried by the piece policy, then the requester gets the failure', async () => {
  await using h = setup({ localRequests: true });
  let attempts = 0;
  const failing = on(CreateTodo, () => {
    attempts += 1;
    throw new Error('store unavailable');
  });

  await h.add('store', {
    on: [failing],
    policy: { retry: { maxAttempts: 3, baseMs: 1, maxMs: 1, jitter: 0 } },
  });

  await assert.rejects(h.bus.request(CreateTodo, { title: 'milk' }), /store unavailable/);

  assert.equal(attempts, 3);
  assert.equal(h.sys('delivery.retried').length, 2);
  assert.equal(h.sys('delivery.deadlettered').length, 1);
  assert.deepEqual(overTransport(h.transport.published.map((e) => e.name)), []);
});

test('local and transport deliveries share the piece concurrency limit', async () => {
  await using h = setup({ localRequests: true });
  let running = 0;
  let peak = 0;
  const slow = on(GetTodo, async (input) => {
    running += 1;
    peak = Math.max(peak, running);
    await delay(10);
    running -= 1;

    return { id: input.id, title: 'milk', done: false };
  });
  await h.add('store', { on: [slow], policy: { concurrency: 1 } });
  await using remote = createBus({
    transport: h.memory,
    context: new AsyncLocalStorage(),
    sink: () => {},
    localRequests: false,
  });
  const ids = ['a', 'b', 'c'];

  await Promise.all([
    ...ids.map((id) => h.bus.request(GetTodo, { id })),
    ...ids.map((id) => remote.request(GetTodo, { id })),
  ]);

  assert.equal(peak, 1);
  assert.equal(h.transport.published.filter((e) => e.name === GetTodo.wireName).length, 0);
});

test('a local request over maxBytes rejects and leaves no pending request behind', async () => {
  await using h = setup({ localRequests: true, limits: { maxBytes: 300 }, policy: { requestTimeoutMs: 30 } });
  await h.add('store', { on: [on(CreateTodo, (input) => ({ id: 't1', title: input.title, done: false }))] });
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', record);

  try {
    await assert.rejects(h.bus.request(CreateTodo, { title: 'x'.repeat(190) }), {
      name: 'PayloadTooLargeError',
    });

    await delay(60);
  } finally {
    process.off('unhandledRejection', record);
  }

  assert.equal(h.bus.stats.pendingRequests, 0);
  assert.deepEqual(unhandled, []);
});
