import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import v8 from 'node:v8';
import vm from 'node:vm';

import { createMemoryTransport } from '@murmur/transport-memory';
import {
  CascadeDepthError,
  Command,
  createBus,
  createEnvelope,
  current,
  DuplicateResponderError,
  EmitNotDeclaredError,
  Event,
  HandlerTimeoutError,
  NotRequestableError,
  RemoteError,
  RequestTimeoutError,
  ShutdownError,
  type RequestClass,
  type RunContext,
  ContractViolationError,
} from 'murmur';
import { fakeClock, fakeContextStorage, fakeIds } from 'murmur/testing';
import { z } from 'zod';

import { aborted, on, onWire, runtimeOf, setup, until, type Harness, type PieceSpec } from './bus-harness.ts';

class Ping extends Event({ n: z.number() }, { name: 'test.ping' }) {}
class Pong extends Event({ n: z.number() }, { name: 'test.pong' }) {}
class Other extends Event({}, { name: 'test.other' }) {}
class Add extends Command({ a: z.number(), b: z.number() }, { sum: z.number() }, { name: 'math.add' }) {}

const adder: PieceSpec = { on: [on(Add, ({ a, b }) => ({ sum: a + b }))] };

const sink: PieceSpec = { on: [on(Ping, () => undefined)] };

const hanging: PieceSpec = {
  on: [
    on(Add, async (_input, { signal }) => {
      await aborted(signal);
      throw signal.reason;
    }),
  ],
};

function errorName(e: { payload: Record<string, unknown> }): unknown {
  return (e.payload['error'] as { name?: string } | undefined)?.name;
}

async function relay(h: Harness): Promise<void> {
  await h.add('a', { emits: [Pong], on: [on(Ping, ({ n }, { port }) => port.emit(Pong, { n }))] });
  await h.add('b', { on: [on(Pong, () => undefined)] });
  await h.bus.emit(Ping, { n: 1 });
  await until(() => h.sys('delivery.acked').length === 2);
  await h.memory.idle();
}

test('request round-trips with a typed reply', async () => {
  await using h = setup();
  await h.add('math/adder', adder);
  const reply: { sum: number } = await h.bus.request(Add, { a: 2, b: 3 });
  assert.deepEqual(reply, { sum: 5 });
  const completed = h.sys('request.completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.payload['ok'], true);
});

test('a # observer registered before the responder never answers', async () => {
  await using h = setup();
  const seen: string[] = [];

  await h.bus.observe('#', 'tail', (e) => {
    seen.push(e.name);
  });

  await h.add('math/adder', adder);
  assert.deepEqual(await h.bus.request(Add, { a: 1, b: 1 }), { sum: 2 });
  const replies = h.transport.published.filter((e) => e.name.startsWith('$reply.'));
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.source, 'math/adder');
  await until(() => seen.includes('math.add'));
});

test('3 throws with maxAttempts 3 → failed×3, retried×2, deadlettered×1 in order', async () => {
  await using h = setup();

  await h.add('flaky', {
    policy: { retry: { maxAttempts: 3, baseMs: 1, maxMs: 1, jitter: 0 } },
    on: [
      on(Ping, () => {
        throw new Error('boom');
      }),
    ],
  });

  await h.bus.emit(Ping, { n: 1 });
  await until(() => h.sys('delivery.deadlettered').length === 1);
  const sequence = h
    .sysNames()
    .filter((name) => /^delivery\.(failed|retried|deadlettered)$/.test(name))
    .map((name) => name.slice(9));
  assert.deepEqual(sequence, ['failed', 'retried', 'failed', 'retried', 'failed', 'deadlettered']);
  const dead = h.sys('delivery.deadlettered')[0];
  assert.equal(dead?.payload['attempts'], 3);
  assert.equal(dead?.payload['phase'], 'handler');
  assert.deepEqual(
    h.sys('delivery.failed').map((e) => e.payload['willRetry']),
    [true, true, false],
  );
  await h.memory.idle();
  assert.equal(h.memory.deadLetters.length, 1);
});

test('a handler ignoring its signal past timeoutMs fails with HandlerTimeoutError + delivery.timeout', async () => {
  await using h = setup();
  let reason: unknown;

  await h.add('slow', {
    policy: { timeoutMs: 20, retry: { maxAttempts: 1 } },
    on: [
      on(Ping, async (_event, { signal }) => {
        await delay(60);
        reason = signal.reason;
      }),
    ],
  });

  await h.bus.emit(Ping, { n: 1 });
  await until(() => h.sys('delivery.deadlettered').length === 1);
  const timeout = h.sys('delivery.timeout');
  assert.equal(timeout.length, 1);
  assert.equal(timeout[0]?.payload['timeoutMs'], 20);
  assert.equal(errorName(h.sys('delivery.failed')[0] ?? { payload: {} }), 'HandlerTimeoutError');
  await until(() => reason !== undefined);
  assert.ok(reason instanceof HandlerTimeoutError);
});

test('emit of an undeclared contract throws EmitNotDeclaredError before publish', async () => {
  await using h = setup();
  let caught: unknown;

  await h.add('sneaky', {
    on: [
      on(Ping, async (_event, { port }) => {
        try {
          await port.emit(Pong, { n: 1 });
        } catch (error) {
          caught = error;
        }
      }),
    ],
  });

  await h.bus.emit(Ping, { n: 1 });
  await until(() => h.sys('delivery.acked').length === 1);
  assert.ok(caught instanceof EmitNotDeclaredError);
  assert.equal(
    h.transport.published.some((e) => e.name === Pong.wireName),
    false,
  );
});

test('an emit started in a handler is awaited before ack', async () => {
  await using h = setup({ delayMs: (e) => (e.name === Pong.wireName ? 30 : 0) });

  await h.add('fire', {
    emits: [Pong],
    on: [
      on(Ping, (_event, { port }) => {
        void port.emit(Pong, { n: 1 });
      }),
    ],
  });

  await h.bus.emit(Ping, { n: 1 });
  await until(() => h.transport.log.includes(`ack:${Ping.wireName}`));
  const log = h.transport.log;
  assert.ok(log.indexOf(`published:${Pong.wireName}`) >= 0);
  assert.ok(log.indexOf(`published:${Pong.wireName}`) < log.indexOf(`ack:${Ping.wireName}`));
});

test('an un-awaited emit rejecting with CascadeDepthError dead-letters with phase emit, never acks', async () => {
  await using h = setup({ limits: { maxHop: 0 } });

  await h.add('loop', {
    emits: [Pong],
    on: [
      on(Ping, (_event, { port }) => {
        void port.emit(Pong, { n: 1 });
      }),
    ],
  });

  await h.bus.emit(Ping, { n: 1 });
  await until(() => h.sys('delivery.deadlettered').length === 1);
  const dead = h.sys('delivery.deadlettered')[0];
  assert.equal(dead?.payload['phase'], 'emit');
  assert.equal(errorName(dead ?? { payload: {} }), 'CascadeDepthError');
  await h.memory.idle();
  assert.equal(h.transport.log.includes(`ack:${Ping.wireName}`), false);
  assert.ok(h.transport.log.includes(`nack:${Ping.wireName}:false`));
});

test('a piece with two handlers receives 6×A only on handler A, through one subscription', async () => {
  await using h = setup();
  const calls = { a: 0, b: 0 };

  const registration = await h.add('both', {
    on: [
      on(Ping, () => {
        calls.a++;
      }),
      on(Other, () => {
        calls.b++;
      }),
    ],
  });

  assert.deepEqual(registration.subscription.patterns, [Ping.wireName, Other.wireName]);
  assert.equal(registration.subscription.group, 'both');
  await Promise.all(Array.from({ length: 6 }, (_, n) => h.bus.emit(Ping, { n })));
  await until(() => h.sys('delivery.acked').length === 6);
  assert.deepEqual(calls, { a: 6, b: 0 });
});

test('an envelope with no handler in the group is dead-lettered with NoHandlerError, never requeued', async () => {
  await using h = setup();

  await h.add('only-ping', sink);

  const stray = createEnvelope({ name: 'test.stray', payload: {}, ids: fakeIds(), clock: fakeClock() });
  h.memory.inject(stray, 'only-ping');
  await until(() => h.sys('delivery.deadlettered').length === 1);
  await h.memory.idle();
  const dead = h.sys('delivery.deadlettered')[0];
  assert.equal(dead?.payload['phase'], 'no-handler');
  assert.equal(errorName(dead ?? { payload: {} }), 'NoHandlerError');
  assert.equal(h.memory.deadLetters.length, 1);
  assert.equal(h.memory.deadLetters[0]?.attempt, 1);
  assert.equal(h.memory.stats.delivered, 1);
});

test("A → B with a # observer: B's acked event and the observer's log record carry their own piece", async () => {
  const storage = new AsyncLocalStorage<RunContext>();
  await using h = setup({ context: storage });
  const inB: (string | undefined)[] = [];
  const observed: { name: string; piece: string | undefined }[] = [];
  const log = (name: string) => {
    observed.push({ name, piece: current(storage)?.piece });
  };
  await h.bus.observe('#', 'tail', (e) => log(e.name));
  await h.add('a', { emits: [Pong], on: [on(Ping, ({ n }, { port }) => port.emit(Pong, { n }))] });

  await h.add('b', {
    on: [
      on(Pong, async () => {
        inB.push(current(storage)?.piece);
        await delay(1);
        inB.push(current(storage)?.piece);
      }),
    ],
  });

  await h.bus.enter({ piece: 'external:test' }, () => h.bus.emit(Ping, { n: 1 }));
  await until(() => h.sys('delivery.acked').length === 2);
  await until(() => observed.some((o) => o.name === Pong.wireName));
  assert.deepEqual(inB, ['b', 'b']);
  const ackedB = h.sys('delivery.acked').find((e) => e.payload['piece'] === 'b');
  assert.equal(ackedB?.source, 'b');
  const pong = h.transport.published.find((e) => e.name === Pong.wireName);
  assert.equal(ackedB?.traceId, pong?.traceId);
  assert.ok(observed.length > 0);
  assert.deepEqual(new Set(observed.map((o) => o.piece)), new Set(['$observer.tail']));
});

test('a request at hop == maxHop gets its reply; request() at hop == maxHop rejects locally', async () => {
  await using h = setup({ limits: { maxHop: 0 } });
  await h.add('math/adder', adder);
  const reply = await h.bus.enter({ piece: 'external:test' }, () => h.bus.request(Add, { a: 1, b: 2 }));
  assert.deepEqual(reply, { sum: 3 });
  assert.equal(h.transport.published.find((e) => e.name.startsWith('$reply.'))?.hop, 1);

  let caught: unknown;

  await h.add('asker', {
    emits: [Add],
    on: [
      on(Ping, async (_event, { port }) => {
        try {
          await port.request(Add, { a: 1, b: 1 });
        } catch (error) {
          caught = error;
        }
      }),
    ],
  });

  await h.bus.emit(Ping, { n: 1 });
  await until(() => caught !== undefined);
  assert.ok(caught instanceof CascadeDepthError);
  assert.equal(h.transport.published.filter((e) => e.name === Add.wireName).length, 1);
});

test('stop() drains an in-flight delivery, runs onStop after it settled, rejects pending requests', async () => {
  await using h = setup();
  const order: string[] = [];

  await h.add('slow', {
    on: [
      on(Ping, async () => {
        await delay(40);
        order.push('handler settled');
      }),
    ],
    stop: () => {
      order.push('onStop');
    },
  });

  await h.add('math/hang', hanging);
  await h.bus.emit(Ping, { n: 1 });
  const pending = h.bus.request(Add, { a: 1, b: 1 });
  const outcome = pending.then(
    () => 'resolved',
    (error: unknown) => error,
  );
  await until(() => h.bus.stats.inflight === 2 && h.bus.stats.pendingRequests === 1);
  await h.bus.stop('test', { graceMs: 100, forceMs: 100 });
  assert.deepEqual(order, ['handler settled', 'onStop']);
  assert.ok(h.transport.log.includes(`ack:${Ping.wireName}`));
  assert.ok((await outcome) instanceof ShutdownError);
  assert.equal(h.sys('runtime.stopped').length, 1);
});

test('heapUsed grows < 1 MB over 50k immediately-resolving deliveries', async () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  const transport = createMemoryTransport();
  await using bus = createBus({ transport, context: new AsyncLocalStorage(), sink: () => {} });

  const registration = await bus.register(runtimeOf('sink', sink));
  await registration.start();
  const burst = async (total: number): Promise<void> => {
    if (total <= 0) {
      return;
    }

    await Promise.all(Array.from({ length: 1_000 }, (_, n) => bus.emit(Ping, { n })));
    await transport.idle();
    await burst(total - 1_000);
  };
  await burst(5_000);
  gc();
  const before = process.memoryUsage().heapUsed;
  await burst(50_000);
  gc();
  const growth = process.memoryUsage().heapUsed - before;
  assert.ok(growth < 1024 * 1024, `heap grew ${growth} bytes`);
});

test('an observer on # produces no additional $sys.* traffic', async () => {
  const without = setup();
  await relay(without);
  const baseline = without.sysNames().toSorted();
  await without[Symbol.asyncDispose]();

  await using h = setup();
  const seen: string[] = [];

  await h.bus.observe('#', 'tail', (e) => {
    seen.push(e.name);
  });

  await relay(h);
  await until(() => seen.some((name) => name.startsWith('$sys.delivery.acked')));
  assert.deepEqual(h.sysNames().toSorted(), baseline);
});

test('request() on a fire-and-forget contract throws NotRequestableError', async () => {
  await using h = setup();
  await assert.rejects(h.bus.request(Ping as unknown as RequestClass, { n: 1 }), NotRequestableError);
});

test('a second responder for one request contract is a DuplicateResponderError', async () => {
  await using h = setup();
  await h.add('math/adder', adder);
  await assert.rejects(h.bus.register(runtimeOf('math/other', adder)), DuplicateResponderError);
});

test('a responder failing terminally rejects the requester with RemoteError', async () => {
  await using h = setup();

  await h.add('math/broken', {
    policy: { retry: { maxAttempts: 1 } },
    on: [
      on(Add, () => {
        throw new Error('no maths today');
      }),
    ],
  });

  await assert.rejects(h.bus.request(Add, { a: 1, b: 1 }), (error: unknown) => {
    assert.ok(error instanceof RemoteError);
    assert.equal(error.message, 'no maths today');

    return true;
  });
});

test('a request nobody answers in time rejects with RequestTimeoutError', async () => {
  await using h = setup();

  await h.add('math/mute', hanging);
  await assert.rejects(h.bus.request(Add, { a: 1, b: 1 }, { timeoutMs: 20 }), RequestTimeoutError);
  assert.equal(h.sys('request.timeout').length, 1);
});

test('the bus runs with fakeContextStorage, which scopes the synchronous part of run()', async () => {
  const storage = fakeContextStorage();
  const store = {
    traceId: 'abcdef01',
    hop: 0,
    piece: 'p',
    signal: new AbortController().signal,
    internal: false,
  };
  assert.equal(
    storage.run(store, () => storage.getStore()?.piece),
    'p',
  );
  assert.equal(storage.getStore(), undefined);
  await using h = setup({ context: storage });
  await h.add('math/adder', adder);
  assert.deepEqual(await h.bus.request(Add, { a: 4, b: 4 }), { sum: 8 });
});

test('a $sys.* handler that throws runs once and is neither retried nor dead-lettered', async () => {
  await using h = setup();
  let calls = 0;

  await h.add('audit', {
    policy: { retry: { maxAttempts: 3, baseMs: 1, maxMs: 1 } },
    on: [
      onWire('$sys.delivery.acked', () => {
        calls++;
        throw new Error('audit down');
      }),
    ],
  });

  await h.add('sink', sink);
  await h.bus.emit(Ping, { n: 1 });
  await until(() => calls === 1);
  await delay(20);
  await h.memory.idle();
  assert.equal(calls, 1);
  assert.equal(h.memory.deadLetters.length, 0);
  assert.equal(h.sys('delivery.deadlettered').length, 0);
  assert.ok(h.lines.some((line) => line.piece === 'audit' && line.level === 'error'));
});

test('a request from an enter context whose responder finishes within grace resolves during stop()', async () => {
  await using h = setup();

  await h.add('math/slow', {
    on: [
      on(Add, async ({ a, b }) => {
        await delay(50);

        return { sum: a + b };
      }),
    ],
  });

  const outcome = h.bus
    .enter({ piece: 'external:test' }, () => h.bus.request(Add, { a: 1, b: 2 }))
    .catch((error: unknown) => error);
  await until(() => h.bus.stats.inflight === 1);
  await h.bus.stop('test', { graceMs: 500, forceMs: 200 });
  assert.deepEqual(await outcome, { sum: 3 });
});

test('a malformed reply rejects the requester with ContractViolationError instead of hanging', async () => {
  await using h = setup();

  await h.add('math/mute', hanging);

  const outcome = h.bus.request(Add, { a: 1, b: 1 }, { timeoutMs: 5_000 }).catch((error: unknown) => error);
  await until(() => h.transport.published.some((e) => e.name === Add.wireName));
  const request = h.transport.published.find((e) => e.name === Add.wireName);
  assert.ok(request?.replyTo !== undefined && request.correlationId !== undefined);
  const reply = createEnvelope({
    name: request.replyTo,
    payload: { ok: false },
    correlationId: request.correlationId,
    ids: fakeIds(),
    clock: fakeClock(),
  });
  h.memory.inject(reply, request.replyTo);
  assert.ok((await outcome) instanceof ContractViolationError);
});

test('parallel registration of two responders for one contract still rejects one', async () => {
  await using h = setup();

  const results = await Promise.allSettled([
    h.bus.register(runtimeOf('math/one', adder)),
    h.bus.register(runtimeOf('math/two', adder)),
  ]);

  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]?.reason instanceof DuplicateResponderError);
});

test('stop disposes the ingress stack before unsubscribing and the capability stack after pending requests', async () => {
  const order: string[] = [];
  const ingress = new AsyncDisposableStack();
  const capabilities = new AsyncDisposableStack();
  ingress.defer(() => {
    order.push('ingress');
  });
  capabilities.defer(() => {
    order.push('capabilities');
  });
  const h = setup({ stacks: { ingress, capabilities } });

  const registration = await h.add('test/pinger', sink);

  const unsubscribe = registration.subscription.unsubscribe.bind(registration.subscription);
  Object.assign(registration.subscription, {
    unsubscribe: async () => {
      order.push('unsubscribe');
      await unsubscribe();
    },
  });
  await h.bus.stop('test');
  assert.equal(order[0], 'ingress');
  assert.equal(order.at(-1), 'capabilities');
  assert.ok(order.includes('unsubscribe'));
  assert.equal(h.sysNames().at(-1), 'runtime.stopped');
});
