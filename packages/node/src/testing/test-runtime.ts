import { setImmediate as nextTurn } from 'node:timers/promises';

import { createMemoryTransport, type MemoryTransport } from '@murmur/transport-memory';
import {
  classPieceRuntime,
  constructPiece,
  createBus,
  isPieceClass,
  matchPattern,
  MurmurError,
  type Bus,
  type Capability,
  type Clock,
  type DeliveryPolicyInput,
  type Envelope,
  type EventClass,
  type InputOf,
  type IngressTarget,
  type LogLine,
  type OutputOf,
  type PieceApi,
  type PieceClass,
  type PieceRuntime,
  type RequestClass,
  type RequestOptions,
  type RetryPolicy,
} from 'murmur';
import { fakeClock, fakeIds, fakeLog, type FakeIds, type FakeLog } from 'murmur/testing';

import { busHost } from '../capabilities/http/host.ts';
import { memoryIdempotencyStore } from '../capabilities/http/idempotency-store.ts';
import { handleHttp } from '../capabilities/http/pipeline.ts';
import { createRouter, type Router } from '../capabilities/http/router.ts';
import { runContext } from '../context.ts';
import { ingressTargets } from '../ingress.ts';
import { routeProblems } from '../loader/bindings.ts';
import { inSequence } from '../sequence.ts';
import { withTap } from '../tap.ts';
import { adoptClock } from './fakes.ts';
import { pieceConfig } from './piece-config.ts';
import { servedSettings } from './served-settings.ts';
import type { TestResponse } from './test-piece.ts';

export type TestPieces = Readonly<Record<string, PieceClass>> | readonly PieceClass[];

export interface TestRuntimeOptions {
  pieces: TestPieces;
  capabilities?: Record<string, unknown>;
  config?: Record<string, Record<string, unknown>>;
  transport?: MemoryTransport;
  policy?: DeliveryPolicyInput;
  now?: string;
}

export interface TestRuntime extends AsyncDisposable {
  readonly bus: Bus;
  readonly transport: MemoryTransport;
  readonly clock: Clock;
  readonly ids: FakeIds;
  readonly log: FakeLog;
  emit<C extends EventClass>(contract: C, payload: InputOf<C>): Promise<void>;
  request<C extends RequestClass>(
    contract: C,
    input: InputOf<C>,
    options?: RequestOptions,
  ): Promise<OutputOf<C>>;
  fetch(request: Request): Promise<TestResponse>;
  idle(): Promise<void>;
  emitted<C extends EventClass>(contract: C): readonly InstanceType<C>[];
  events(pattern: string): readonly Envelope[];
  deadLetters(): readonly Envelope[];
}

const TEST_RETRY: RetryPolicy = { maxAttempts: 5, baseMs: 0, maxMs: 0, jitter: 0 };

function testPolicy(policy: DeliveryPolicyInput | undefined): DeliveryPolicyInput {
  return { ...policy, retry: { ...TEST_RETRY, ...policy?.retry } };
}

function sinkInto(log: FakeLog): (line: LogLine) => void {
  return (line) =>
    log[line.level](line.msg, {
      piece: line.piece,
      ...line.fields,
      ...(line.error === undefined ? {} : { error: line.error }),
    });
}

async function settle(memory: MemoryTransport, captured: readonly Envelope[]): Promise<void> {
  const seen = captured.length;
  await memory.idle();
  await nextTurn();

  if (captured.length !== seen) {
    await settle(memory, captured);
  }
}

interface Built {
  readonly runtimes: PieceRuntime[];
  readonly classes: { readonly name: string; readonly piece: PieceClass }[];
  readonly instances: Map<string, object>;
}

interface Shared {
  readonly options: TestRuntimeOptions;
  readonly bus: Bus;
  readonly capabilities: Record<string, unknown>;
  readonly clock: Clock;
  readonly ids: FakeIds;
  readonly log: FakeLog;
  readonly built: Built;
}

function kebabOf(name: string): string {
  return name.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function pieceEntries(pieces: TestPieces): [string, PieceClass][] {
  if (Array.isArray(pieces)) {
    return pieces.map((piece: PieceClass) => [kebabOf(piece.name), piece]);
  }

  return Object.entries(pieces);
}

function capabilityOf(shared: Shared, id: string, token: Capability, field: string): unknown {
  if (!(token.name in shared.capabilities)) {
    throw new MurmurError(
      `createTestRuntime: ${id} needs ${token.name} (needs.${field}); pass it in options.capabilities`,
      { retryable: false },
    );
  }

  adoptClock(shared.capabilities[token.name], shared.clock);

  return shared.capabilities[token.name];
}

function classApi(shared: Shared, id: string, piece: PieceClass): PieceApi {
  const port = shared.bus.portFor(id);

  return {
    piece: id,
    log: shared.log,
    clock: shared.clock,
    ids: shared.ids,
    config: pieceConfig(id, piece, shared.options.config?.[id] ?? {}),
    resolve: (token, field) => capabilityOf(shared, id, token, field),
    emit: port.emit,
    request: port.request,
  };
}

function addClassPiece(shared: Shared, id: string, piece: PieceClass): void {
  const { built } = shared;
  built.instances.set(id, constructPiece(piece, classApi(shared, id, piece)));
  built.classes.push({ name: id, piece });
  built.runtimes.push(
    classPieceRuntime({
      name: id,
      piece,
      instance: () => built.instances.get(id) ?? {},
    }),
  );
}

function addPiece(shared: Shared, id: string, value: PieceClass): void {
  if (!isPieceClass(value)) {
    throw new MurmurError(`createTestRuntime: ${id} is not a piece class`, { retryable: false });
  }

  addClassPiece(shared, id, value);
}

function buildPieces(shared: Shared): void {
  const entries = pieceEntries(shared.options.pieces).toSorted(([a], [b]) => a.localeCompare(b));
  for (const [id, value] of entries) {
    addPiece(shared, id, value);
  }
}

function servedTargets(built: Built): IngressTarget[] {
  return built.classes.flatMap(({ name, piece }) =>
    ingressTargets(name, piece, () => built.instances.get(name) ?? {}),
  );
}

function assertRoutes(targets: readonly IngressTarget[]): void {
  const served = targets.map((target) => ({ piece: target.piece, binding: target.serve.binding }));
  const problems = routeProblems(served);

  if (problems.length > 0) {
    throw new MurmurError(`createTestRuntime: ${problems.map((p) => p.message).join('; ')}`, {
      retryable: false,
    });
  }
}

function routerOf(shared: Shared): Router {
  const targets = servedTargets(shared.built);
  assertRoutes(targets);

  return createRouter(
    targets,
    servedSettings(
      targets,
      shared.built.classes.map(({ piece }) => piece),
    ),
  );
}

export async function createTestRuntime(options: TestRuntimeOptions): Promise<TestRuntime> {
  const memory = options.transport ?? createMemoryTransport();
  const captured: Envelope[] = [];
  const clock = fakeClock(options.now);
  const ids = fakeIds();
  const log = fakeLog();
  const bus = createBus({
    transport: withTap(memory, (envelope) => captured.push(envelope)),
    context: runContext,
    ids,
    clock,
    policy: testPolicy(options.policy),
    observability: { payloads: true },
    mode: 'dev',
    sink: sinkInto(log),
  });
  const built: Built = { runtimes: [], classes: [], instances: new Map() };
  const shared: Shared = { options, bus, capabilities: options.capabilities ?? {}, clock, ids, log, built };
  buildPieces(shared);
  const router = routerOf(shared);
  const host = busHost({
    bus,
    invoke: bus.invoke,
    mode: 'dev',
    log,
    freshTraceId: () => ids.uuid(),
    idempotency: memoryIdempotencyStore(clock),
  });
  const registrations = await inSequence(built.runtimes, (runtime) => bus.register(runtime));
  await inSequence(registrations, (registration) => registration.start());

  return {
    bus,
    transport: memory,
    clock,
    ids,
    log,
    emit: (contract, payload) => bus.emit(contract, payload),
    request: (contract, input, requestOptions) => bus.request(contract, input, requestOptions),
    fetch: (request) => handleHttp(request, router, host),
    idle: () => settle(memory, captured),
    emitted: (contract: EventClass) =>
      captured.filter((e) => e.name === contract.wireName).map((e) => e.payload as never),
    events: (pattern) => captured.filter((e) => matchPattern(pattern, e.name)),
    deadLetters: () => memory.deadLetters.map((d) => d.envelope),
    [Symbol.asyncDispose]: () => bus.stop('test'),
  } as TestRuntime;
}
