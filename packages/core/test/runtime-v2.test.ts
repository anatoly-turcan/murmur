import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  classPieceRuntime,
  constructPiece,
  EmitNotDeclaredError,
  Handle,
  isSettledLifecycleRun,
  Piece,
  type Delivery,
  type PieceClass,
  type Registration,
  type RunContext,
} from 'murmur';
import { fakeClock, fakeIds, fakeLog } from 'murmur/testing';

import { setup, until, type Harness, type SysEnvelope } from './bus-harness.ts';
import { decorate } from './decorate.ts';
import {
  CompleteTodo,
  CreateTodo,
  GetTodo,
  ListTodos,
  TodoArchived,
  TodoCreated,
  TodoRemoved,
  type Todo,
} from './fixtures/v2/contracts/todos.ts';

const calls = { get: 0, create: 0, complete: 0 };
let frontWork: (front: Front) => Promise<unknown> = async () => undefined;
let openStream: ReadableStream<string> | undefined;
let storeDelayMs = 10;

class Front extends Piece({ emits: [TodoCreated, TodoRemoved] }) {
  readonly emitter = new EventEmitter();

  async list(): Promise<Todo[]> {
    await frontWork(this);

    return [];
  }

  async stream(): Promise<Todo | null> {
    openStream = new ReadableStream<string>({
      cancel: () => {
        void this.emit(TodoCreated, { id: 'stream', title: 'cancelled' });
      },
    });

    return null;
  }

  onStart(): void {
    this.emitter.on('ping', () => {
      void this.emit(TodoCreated, { id: 'emitter', title: 'pinged' });
    });
  }

  announce(): void {
    void this.emit(TodoCreated, { id: 'entry', title: 'from an ingress entry' });
  }

  archive(): Promise<void> {
    return this.emit(TodoArchived, { id: '1' });
  }
}

class Store extends Piece() {
  async get(input: GetTodo, delivery: Delivery): Promise<Todo | null> {
    calls.get += 1;
    await delay(storeDelayMs);

    return { id: input.id, title: `answered in ${delivery.piece}`, done: false };
  }

  async create(input: CreateTodo): Promise<Todo> {
    calls.create += 1;

    return { id: String(calls.create), title: input.title, done: false };
  }
}

decorate(Front, [
  { decorators: [Handle(ListTodos)], name: 'list' },
  { decorators: [Handle(CompleteTodo)], name: 'stream' },
]);
decorate(Store, [
  { decorators: [Handle(GetTodo)], name: 'get' },
  { decorators: [Handle(CreateTodo)], name: 'create' },
]);

class Completer extends Piece({
  policy: { retry: { maxAttempts: 5, baseMs: 150, maxMs: 1_000, jitter: 0 } },
}) {
  async complete(): Promise<Todo | null> {
    calls.complete += 1;
    throw new Error('store unavailable');
  }
}

decorate(Completer, [{ decorators: [Handle(CompleteTodo)], name: 'complete' }]);

async function addClassPiece<P extends PieceClass>(
  h: Harness,
  id: string,
  piece: P,
): Promise<InstanceType<P>> {
  let instance: InstanceType<P> | undefined;

  const registration: Registration = await h.bus.register(
    classPieceRuntime({ name: id, piece, instance: () => instance as object }),
  );

  const port = h.bus.portFor(id);
  instance = constructPiece(piece, {
    piece: id,
    log: fakeLog(),
    clock: fakeClock(),
    ids: fakeIds(),
    config: {},
    resolve: () => undefined,
    emit: port.emit,
    request: port.request,
  });
  await registration.start();

  return instance;
}

function reset(): void {
  Object.assign(calls, { get: 0, create: 0, complete: 0 });
  frontWork = async () => undefined;
  openStream = undefined;
  storeDelayMs = 10;
}

function published(h: Harness, name: string): SysEnvelope[] {
  return h.transport.published.filter((e) => e.name === name) as SysEnvelope[];
}

async function flock(h: Harness): Promise<Front> {
  const front = await addClassPiece(h, 'front', Front);
  await addClassPiece(h, 'store', Store);

  return front;
}

test('a class piece built by classPieceRuntime answers a Query through the bus', async () => {
  reset();
  await using h = setup();
  await flock(h);

  assert.deepEqual(await h.bus.request(GetTodo, { id: 't1' }), {
    id: 't1',
    title: 'answered in store',
    done: false,
  });
});

test('two identical GetTodo queries in one trace send one envelope, deduped: 1 and one $sys.request.deduped', async () => {
  reset();
  await using h = setup();
  await flock(h);
  frontWork = (front) =>
    Promise.all([front.request(GetTodo, { id: '1' }), front.request(GetTodo, { id: '1' })]);

  await h.bus.request(ListTodos, {});
  const completed = h.sys('request.completed').filter((e) => e.payload['name'] === GetTodo.wireName);

  assert.equal(published(h, GetTodo.wireName).length, 1);
  assert.equal(calls.get, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.payload['deduped'], 1);
  assert.equal(h.sys('request.deduped').length, 1);
  assert.equal(h.sys('request.deduped')[0]?.payload['byPiece'], 'front');
});

test('a dedupe leader whose run aborts with no follower drops its pending request instead of timing out', async () => {
  reset();
  storeDelayMs = 150;
  await using h = setup();
  await flock(h);
  const caller = new AbortController();
  const entry = h.bus.invoke('front', { transport: 'test', binding: 'probe', signal: caller.signal }, () =>
    h.bus.portFor('front').request(GetTodo, { id: '1' }, { timeoutMs: 100 }),
  );

  await until(() => published(h, GetTodo.wireName).length === 1);
  caller.abort(new Error('client went away'));
  await assert.rejects(entry, /client went away/);
  await delay(200);

  assert.equal(h.sys('request.timeout').length, 0);
});

test('a second query with its own signal is not deduplicated', async () => {
  reset();
  await using h = setup();
  await flock(h);
  const own = new AbortController();
  frontWork = (front) =>
    Promise.all([
      front.request(GetTodo, { id: '1' }),
      front.request(GetTodo, { id: '1' }, { signal: own.signal }),
    ]);

  await h.bus.request(ListTodos, {});

  assert.equal(published(h, GetTodo.wireName).length, 2);
  assert.equal(h.sys('request.deduped').length, 0);
});

test('a Command is never deduplicated', async () => {
  reset();
  await using h = setup();
  await flock(h);
  frontWork = (front) =>
    Promise.all([front.request(CreateTodo, { title: 'milk' }), front.request(CreateTodo, { title: 'milk' })]);

  await h.bus.request(ListTodos, {});

  assert.equal(published(h, CreateTodo.wireName).length, 2);
  assert.equal(calls.create, 2);
  assert.equal(h.sys('request.deduped').length, 0);
});

test('a Command that throws behind request({ timeoutMs: 400 }) is not attempted after the deadline: requester-gone', async () => {
  reset();
  await using h = setup();
  await addClassPiece(h, 'completer', Completer);
  await assert.rejects(h.bus.request(CompleteTodo, { id: '1' }, { timeoutMs: 400 }));
  await until(() => h.sys('delivery.deadlettered').length === 1);
  await delay(100);
  const failed = h.sys('delivery.failed');

  assert.equal(calls.complete, 2);
  assert.deepEqual(
    failed.map((e) => [e.payload['willRetry'], e.payload['reason']]),
    [
      [true, undefined],
      [false, 'requester-gone'],
    ],
  );
  assert.equal(h.sys('delivery.deadlettered')[0]?.payload['reason'], 'requester-gone');
  assert.equal(h.memory.deadLetters.length, 1);
});

test('bus.invoke drains an un-awaited emit before returning and publishes $sys.ingress.completed', async () => {
  reset();
  await using h = setup({ delayMs: (e) => (e.name === TodoCreated.wireName ? 30 : 0) });
  const front = await flock(h);
  const traceId = 'abcdef0123456789';
  let seen: Delivery | undefined;

  const result = await h.bus.invoke(
    'front',
    { transport: 'http', binding: 'GET /todos', traceId, payload: { method: 'GET', path: '/todos' } },
    (delivery) => {
      seen = delivery;
      front.announce();

      return 'answered';
    },
  );

  assert.equal(result, 'answered');
  assert.ok(h.transport.log.includes(`published:${TodoCreated.wireName}`));
  assert.equal(published(h, TodoCreated.wireName)[0]?.traceId, traceId);
  assert.equal(seen?.envelope.name, '$ingress.http');
  assert.deepEqual(seen?.envelope.payload, { method: 'GET', path: '/todos', binding: 'GET /todos' });
  assert.equal(seen?.piece, 'front');
  assert.deepEqual(
    h.sysNames().filter((name) => name.startsWith('ingress.')),
    ['ingress.received', 'ingress.completed'],
  );
  assert.equal(h.sys('ingress.completed')[0]?.payload['binding'], 'GET /todos');
  assert.deepEqual(h.sys('ingress.received')[0]?.payload['envelope'], seen?.envelope);
});

test('a throwing bus.invoke entry rejects with the error and publishes $sys.ingress.failed', async () => {
  reset();
  await using h = setup();
  await flock(h);

  await assert.rejects(
    h.bus.invoke('front', { transport: 'http', binding: 'POST /todos' }, () => {
      throw new Error('edge broke');
    }),
    { message: 'edge broke' },
  );

  assert.equal(
    h.sys('ingress.failed')[0]?.payload['traceId'],
    h.sys('ingress.received')[0]?.payload['traceId'],
  );
});

function backgroundRoot(h: Harness, id: string): { envelope: SysEnvelope; record: SysEnvelope | undefined } {
  const envelope = published(h, TodoCreated.wireName).find((e) => e.payload['id'] === id) as SysEnvelope;
  const record = h.sys('emit.background').find((e) => e.traceId === envelope.traceId);

  return { envelope, record };
}

test('this.emit from an EventEmitter listener publishes under a background root with $sys.emit.background', async () => {
  reset();
  await using h = setup();
  const front = await flock(h);

  front.emitter.emit('ping');
  await until(() => published(h, TodoCreated.wireName).length === 1);
  const { envelope, record } = backgroundRoot(h, 'emitter');

  assert.equal(envelope.hop, 0);
  assert.equal(envelope.causationId, undefined);
  assert.equal(envelope.source, 'front');
  assert.equal(record?.source, 'background');
  assert.deepEqual(
    { piece: record?.payload['piece'], contract: record?.payload['contract'] },
    { piece: 'front', contract: TodoCreated.wireName },
  );
});

test('this.emit from a ReadableStream.cancel publishes under a background root with $sys.emit.background', async () => {
  reset();
  await using h = setup();
  await flock(h);
  await h.bus.request(CompleteTodo, { id: '1' });
  await openStream?.cancel('client went away');
  await until(() => published(h, TodoCreated.wireName).length === 1);
  const { envelope, record } = backgroundRoot(h, 'stream');
  const requestTrace = published(h, CompleteTodo.wireName)[0]?.traceId;

  assert.notEqual(envelope.traceId, requestTrace);
  assert.equal(envelope.hop, 0);
  assert.equal(record?.payload['piece'], 'front');
});

class Poller extends Piece({ emits: [TodoCreated] }) {
  #ticks = 0;
  #timer: NodeJS.Timeout | undefined;

  onStart(): void {
    this.#timer = setInterval(() => {
      this.#ticks += 1;
      void this.emit(TodoCreated, { id: `tick-${this.#ticks}`, title: 'polled' });
    }, 5);
  }

  onStop(): void {
    clearInterval(this.#timer);
  }
}

test('this.emit from a setInterval started in onStart opens one background root per tick, not the onStart run', async () => {
  reset();
  await using h = setup();
  const poller = await addClassPiece(h, 'poller', Poller);
  await until(() => published(h, TodoCreated.wireName).length >= 3);
  poller.onStop();
  const ticks = published(h, TodoCreated.wireName);
  const traces = new Set(ticks.map((e) => e.traceId));
  const roots = h.sys('emit.background').filter((e) => traces.has(e.traceId));

  assert.equal(traces.size, ticks.length);
  assert.equal(roots.length, ticks.length);
  assert.ok(ticks.every((e) => e.hop === 0 && e.causationId === undefined));
});

const lifecycleStorage = new AsyncLocalStorage<RunContext>();
const lifecycleSettled: boolean[] = [];

function recordLifecycleSettled(): void {
  const run = lifecycleStorage.getStore();
  if (run !== undefined) {
    lifecycleSettled.push(isSettledLifecycleRun(run));
  }
}

class Ticker extends Piece({ emits: [TodoCreated] }) {
  onStart(): void {
    recordLifecycleSettled();
    setTimeout(recordLifecycleSettled, 5);
  }
}

test('a timer opened in onStart sees the onStart run as settled once the hook returned', async () => {
  reset();
  lifecycleSettled.length = 0;
  await using h = setup({ context: lifecycleStorage });
  await addClassPiece(h, 'ticker', Ticker);
  await until(() => lifecycleSettled.length === 2);

  assert.deepEqual(lifecycleSettled, [false, true]);
});

test('emit of an undeclared same-shape event throws at runtime with the piece and the wire name', async () => {
  reset();
  await using h = setup();
  const front = await flock(h);

  await assert.rejects(
    h.bus.invoke('front', { transport: 'http', binding: 'POST /archive' }, () => front.archive()),
    (error: unknown) =>
      error instanceof EmitNotDeclaredError &&
      error.message.startsWith('piece front emits todos.archived but does not declare it'),
  );

  assert.equal(published(h, 'todos.archived').length, 0);
});

test('a request carries a deadline of ts + timeoutMs; an event carries none', async () => {
  reset();
  await using h = setup();
  await flock(h);
  await h.bus.request(GetTodo, { id: '1' }, { timeoutMs: 1_500 });
  await h.bus.emit(TodoRemoved, { id: '1' }).catch(() => undefined);
  const request = published(h, GetTodo.wireName)[0];
  const elapsed = Temporal.Instant.from(request?.deadline ?? '').since(
    Temporal.Instant.from(request?.ts ?? ''),
  );

  assert.equal(elapsed.total('milliseconds'), 1_500);
  assert.equal(published(h, TodoRemoved.wireName)[0]?.deadline, undefined);
});

class Looper extends Piece({ emits: [TodoRemoved] }) {
  created(todo: { id: string }): void {
    void this.emit(TodoRemoved, { id: todo.id });
  }
}

decorate(Looper, [{ decorators: [Handle(TodoCreated)], name: 'created' }]);

test('an un-awaited this.emit rejecting with CascadeDepthError dead-letters with phase emit', async () => {
  await using h = setup({ limits: { maxHop: 0 } });
  await addClassPiece(h, 'looper', Looper);
  await h.bus.emit(TodoCreated, { id: 't1', title: 'loop' });
  await until(() => h.sys('delivery.deadlettered').length === 1);

  assert.equal(h.sys('delivery.deadlettered')[0]?.payload['phase'], 'emit');
  assert.equal(published(h, TodoRemoved.wireName).length, 0);
});
