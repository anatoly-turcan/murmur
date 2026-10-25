import { dirname } from 'node:path';

import {
  answerOf,
  constructPiece,
  describePiece,
  markLifecycleSettled,
  MurmurError,
  NoHandlerError,
  parseWire,
  pieceFileOf,
  type Capability,
  type CapabilityFake,
  type Clock,
  type CommandClass,
  type ContractClass,
  type DeclaredShape,
  type Delivery,
  type Envelope,
  type EntryFn,
  type EventClass,
  type HandlerEntry,
  type IngressTarget,
  type Injected,
  type InputOf,
  type InvokeInit,
  type OutputOf,
  type PieceApi,
  type PieceClass,
  type RequestClass,
  type RunContext,
  type Schema,
} from 'murmur';
import { fakeClock, fakeIds, fakeLog, type FakeIds, type FakeLog } from 'murmur/testing';
import type { z } from 'zod';

import { memoryIdempotencyStore, type IdempotencyStore } from '../capabilities/http/idempotency-store.ts';
import { handleHttp, type HttpHost } from '../capabilities/http/pipeline.ts';
import { createRouter } from '../capabilities/http/router.ts';
import { builtinCapabilities } from '../capabilities/registry.ts';
import type { EnqueueOptions } from '../capabilities/types.ts';
import { runContext } from '../context.ts';
import { ingressTargets } from '../ingress.ts';
import { inSequence } from '../sequence.ts';
import { appRootOf } from './app-root.ts';
import {
  adoptClock,
  clearJobs,
  jobRecordsOf,
  markRan,
  pendingJobs,
  recordedJobs,
  type JobRecords,
  type RecordedJob,
} from './fakes.ts';
import { pieceConfig } from './piece-config.ts';
import { servedSettings } from './served-settings.ts';

export interface DeliverOptions {
  readonly attempt?: number;
  readonly traceId?: string;
  readonly envelopeId?: string;
}

type DeclarationOf<P> = P extends { readonly '~declaration'?: infer D } ? NonNullable<D> : never;

type SchemaInput<S> = S extends z.ZodType ? z.input<S> : never;

type OptionalKeys<Cfg> = { [K in keyof Cfg]: undefined extends SchemaInput<Cfg[K]> ? K : never }[keyof Cfg];

type ConfigInput<Cfg> = { readonly [K in Exclude<keyof Cfg, OptionalKeys<Cfg>>]: SchemaInput<Cfg[K]> } & {
  readonly [K in OptionalKeys<Cfg>]?: SchemaInput<Cfg[K]>;
};

export type NeedsOf<P> = DeclarationOf<P> extends DeclaredShape<infer N, unknown, unknown> ? Injected<N> : {};

export type ConfigInputOf<P> =
  DeclarationOf<P> extends DeclaredShape<unknown, infer Cfg, unknown> ? ConfigInput<Cfg> : {};

export type EmitsOf<P> = DeclarationOf<P> extends DeclaredShape<unknown, unknown, infer E> ? E : never;

type NeedsOption<N> = keyof N extends never
  ? { readonly needs?: undefined }
  : { readonly needs?: Partial<N> };

type ConfigOption<C> = keyof C extends never ? { readonly config?: undefined } : { readonly config: C };

export type TestPieceOptions<P> = NeedsOption<NeedsOf<P>> &
  ConfigOption<ConfigInputOf<P>> & { readonly auth?: unknown; readonly now?: string; readonly id?: string };

export interface FetchOptions {
  readonly auth?: unknown;
}

export type TestResponse = Response;

type OptionsArgument<O> = {} extends O ? [options?: O] : [options: O];

export interface EnqueuedJob<C extends CommandClass> {
  readonly input: InstanceType<C>;
  readonly options: EnqueueOptions;
}

export interface RanJobs {
  readonly ran: number;
}

export interface EmittedEvent {
  readonly contract: EventClass;
  readonly payload: unknown;
  readonly causationId: string;
}

export interface TestPiece<P extends PieceClass> extends AsyncDisposable {
  readonly piece: InstanceType<P>;
  readonly needs: NeedsOf<P>;
  readonly log: FakeLog;
  readonly clock: Clock;
  readonly ids: FakeIds;
  start(): Promise<void>;
  stop(): Promise<void>;
  deliver<C extends ContractClass>(
    contract: C,
    input: InputOf<C>,
    options?: DeliverOptions,
  ): Promise<OutputOf<C>>;
  deliverJson<C extends ContractClass>(
    contract: C,
    value: unknown,
    options?: DeliverOptions,
  ): Promise<OutputOf<C>>;
  emitted(): readonly EmittedEvent[];
  emitted<C extends EmitsOf<P>>(contract: C): readonly InstanceType<C & EventClass>[];
  requested<C extends RequestClass>(contract: C): readonly InstanceType<C>[];
  enqueued<C extends CommandClass>(contract: C): readonly EnqueuedJob<C>[];
  runJobs(): Promise<RanJobs>;
  respond<C extends RequestClass>(
    contract: C,
    responder: (input: InstanceType<C>) => OutputOf<C> | Promise<OutputOf<C>>,
  ): void;
  fetch(request: Request, options?: FetchOptions): Promise<TestResponse>;
  reset(): Promise<void>;
}

type Responder = (input: never) => unknown;

interface Scope {
  readonly causationId: string;
  readonly pending: Promise<unknown>[];
}

interface Harness {
  readonly id: string;
  readonly handlers: readonly HandlerEntry[];
  readonly log: FakeLog;
  readonly clock: Clock;
  readonly ids: FakeIds;
  readonly emitted: EmittedEvent[];
  readonly requested: { readonly contract: RequestClass; readonly input: unknown }[];
  readonly responders: Map<string, Responder>;
  readonly scopes: WeakMap<RunContext, Scope>;
  readonly idempotency: IdempotencyStore;
}

interface ClassOptions {
  readonly needs?: Readonly<Record<string, unknown>> | undefined;
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  readonly auth?: unknown;
  readonly now?: string | undefined;
  readonly id?: string | undefined;
}

const DEFAULT_TRACE_ID = 'trace_test';

function createHarness(piece: PieceClass, options: ClassOptions): Harness {
  const clock = fakeClock(options.now);

  return {
    id: options.id ?? 'test',
    handlers: describePiece(piece).handlers,
    log: fakeLog(),
    clock,
    ids: fakeIds(),
    emitted: [],
    requested: [],
    responders: new Map(),
    scopes: new WeakMap(),
    idempotency: memoryIdempotencyStore(clock),
  };
}

type FakeContext = Omit<CapabilityFake, 'needs'>;

function fakeContext(h: Harness, piece: PieceClass): FakeContext {
  const file = pieceFileOf(piece);
  const pieceDir = file === undefined ? undefined : dirname(file);

  return { root: pieceDir === undefined ? process.cwd() : appRootOf(pieceDir), pieceDir, clock: h.clock };
}

function fakeOf(piece: PieceClass, field: string, token: Capability): (ctx: CapabilityFake) => unknown {
  const fake: unknown = Reflect.get(token, 'fake');
  if (typeof fake !== 'function') {
    throw new MurmurError(
      `testPiece: ${piece.name} needs ${field} (${token.name}), which has no fake; pass it in options.needs ({ needs: { ${field}: … } }) or give the capability one: defineCapability({ …, fake: ({ clock }) => handle })`,
      { code: 'test-need-unfaked', retryable: false },
    );
  }

  return (ctx) => Reflect.apply(fake, token, [ctx]);
}

function capabilityNeeds(token: Capability): readonly string[] {
  const needs: unknown = Reflect.get(token, 'needs');

  return Array.isArray(needs) ? needs.filter((name) => typeof name === 'string') : [];
}

class NeedProvider {
  readonly #faked = new Map<string, Promise<unknown>>();
  readonly #piece: PieceClass;
  readonly #declared: readonly (readonly [string, Capability])[];
  readonly #given: Readonly<Record<string, unknown>>;
  readonly #ctx: FakeContext;

  constructor(piece: PieceClass, given: Readonly<Record<string, unknown>>, ctx: FakeContext) {
    this.#piece = piece;
    this.#declared = Object.entries(piece.declaration.needs ?? {});
    this.#given = given;
    this.#ctx = ctx;
  }

  async fields(): Promise<Record<string, unknown>> {
    const entries = await Promise.all(
      this.#declared.map(async ([field, token]) => [field, await this.#field(field, token)] as const),
    );

    return Object.fromEntries(entries);
  }

  #field(field: string, token: Capability): Promise<unknown> {
    return field in this.#given ? Promise.resolve(this.#given[field]) : this.#fake(field, token);
  }

  #fake(field: string, token: Capability): Promise<unknown> {
    const made = this.#faked.get(token.name) ?? this.#make(field, token);
    this.#faked.set(token.name, made);

    return made;
  }

  async #make(field: string, token: Capability): Promise<unknown> {
    const names = capabilityNeeds(token);
    const handles = await Promise.all(names.map((name) => this.#dependency(field, token, name)));

    return fakeOf(this.#piece, field, token)({ ...this.#ctx, needs: Object.fromEntries(handles) });
  }

  async #dependency(field: string, token: Capability, name: string): Promise<readonly [string, unknown]> {
    const declared = this.#declared.find(([, candidate]) => candidate.name === name);
    if (declared !== undefined) {
      return [name, await this.#field(...declared)];
    }

    const builtin = builtinCapabilities().find((candidate) => candidate.name === name);
    if (builtin === undefined) {
      throw new MurmurError(
        `testPiece: ${this.#piece.name} needs ${field} (${token.name}), whose fake needs ${name}; pass ${field} in options.needs ({ needs: { ${field}: … } })`,
        { code: 'test-need-unfaked', retryable: false },
      );
    }

    return [name, await this.#fake(field, builtin)];
  }
}

async function provisionNeeds(
  h: Harness,
  piece: PieceClass,
  given: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const needs = await new NeedProvider(piece, given, fakeContext(h, piece)).fields();
  for (const need of Object.values(needs)) {
    adoptClock(need, h.clock);
  }

  return needs;
}

function currentScope(h: Harness): Scope {
  const run = runContext.getStore();
  const scope = run === undefined ? undefined : h.scopes.get(run);

  return scope ?? { causationId: '', pending: [] };
}

function tracked<T>(scope: Scope, work: Promise<T>): Promise<T> {
  work.catch(() => {});
  scope.pending.push(work);

  return work;
}

async function recordEmit(h: Harness, scope: Scope, contract: EventClass, payload: unknown): Promise<void> {
  const value = await parseWire(contract.wireName, 'payload', contract.input as Schema, payload);
  h.emitted.push({ contract, payload: value, causationId: scope.causationId });
}

async function answer(h: Harness, contract: RequestClass, input: unknown): Promise<unknown> {
  const value = await parseWire(contract.wireName, 'payload', contract.input as Schema, input);
  h.requested.push({ contract, input: value });
  const responder = h.responders.get(contract.wireName);
  if (responder === undefined) {
    throw new MurmurError(
      `testPiece: no responder for ${contract.wireName}; call .respond(${contract.name}, fn) first`,
    );
  }

  return parseWire(contract.wireName, 'reply', contract.output as Schema, await responder(value as never));
}

function portOf(
  h: Harness,
  piece: PieceClass,
  options: ClassOptions,
  needs: Readonly<Record<string, unknown>>,
): PieceApi {
  return {
    piece: h.id,
    log: h.log,
    clock: h.clock,
    ids: h.ids,
    config: pieceConfig(h.id, piece, options.config ?? {}),
    resolve: (_token: Capability, field: string) => needs[field],
    emit: (contract, payload) => {
      const scope = currentScope(h);

      return tracked(scope, recordEmit(h, scope, contract, payload));
    },
    request: (contract, input) => tracked(currentScope(h), answer(h, contract, input)),
  };
}

async function drain(pending: readonly Promise<unknown>[], from = 0): Promise<void> {
  if (from >= pending.length) {
    return;
  }

  const until = pending.length;
  await Promise.all(pending.slice(from, until));
  await drain(pending, until);
}

function runOf(h: Harness, scope: Scope, envelope: Envelope, attempt: number): RunContext {
  const run: RunContext = {
    traceId: envelope.traceId,
    hop: envelope.hop,
    piece: h.id,
    deliveryId: crypto.randomUUID(),
    attempt,
    signal: new AbortController().signal,
    internal: false,
    eventId: envelope.id,
  };
  h.scopes.set(run, scope);

  return run;
}

function lifecycleRunOf(h: Harness): RunContext {
  const run: RunContext = {
    traceId: DEFAULT_TRACE_ID,
    hop: -1,
    piece: h.id,
    signal: new AbortController().signal,
    internal: false,
  };
  h.scopes.set(run, { causationId: '', pending: [] });

  return run;
}

async function inRun<T>(h: Harness, run: RunContext, work: () => Promise<T>): Promise<T> {
  const scope = h.scopes.get(run) ?? { causationId: '', pending: [] };

  return runContext.run(run, async () => {
    const result = await work();
    await drain(scope.pending);

    return result;
  });
}

function handlerFor(h: Harness, contract: ContractClass): HandlerEntry {
  const entry = h.handlers.find((candidate) => candidate.contract.wireName === contract.wireName);
  if (entry === undefined) {
    throw new NoHandlerError(h.id, contract.wireName);
  }

  return entry;
}

function envelopeOf(
  h: Harness,
  contract: ContractClass,
  payload: unknown,
  options: DeliverOptions,
): Envelope {
  return {
    id: options.envelopeId ?? crypto.randomUUID(),
    name: contract.wireName,
    traceId: options.traceId ?? DEFAULT_TRACE_ID,
    ts: h.clock.now().toString(),
    hop: 0,
    payload,
  };
}

async function deliver(
  h: Harness,
  instance: object,
  contract: ContractClass,
  input: unknown,
  options: DeliverOptions = {},
): Promise<unknown> {
  const entry = handlerFor(h, contract);
  const value = await parseWire(contract.wireName, 'payload', contract.input as Schema, input);
  const envelope = envelopeOf(h, contract, value, options);
  const attempt = options.attempt ?? 1;
  const run = runOf(h, { causationId: envelope.id, pending: [] }, envelope, attempt);
  const delivery: Delivery = { envelope, attempt, signal: run.signal, piece: h.id };

  const result = await inRun(h, run, async () =>
    answerOf(entry.contract, entry.get(instance).call(instance, value, delivery)),
  );

  if (contract.output === undefined) {
    return undefined;
  }

  return parseWire(contract.wireName, 'reply', contract.output as Schema, result);
}

async function runHook(h: Harness, instance: object, hook: 'onStart' | 'onStop'): Promise<void> {
  const method: unknown = Reflect.get(instance, hook);
  if (typeof method !== 'function') {
    return;
  }

  const run = lifecycleRunOf(h);

  try {
    await inRun(h, run, async () => Reflect.apply(method, instance, []));
  } finally {
    markLifecycleSettled(run);
  }
}

function invokeEntry<R>(h: Harness, init: InvokeInit, fn: EntryFn<R>): Promise<Awaited<R>> {
  const envelope: Envelope = {
    id: crypto.randomUUID(),
    name: `$ingress.${init.transport}`,
    traceId: init.traceId ?? DEFAULT_TRACE_ID,
    ts: h.clock.now().toString(),
    hop: 0,
    source: `external:${init.transport}`,
    payload: { ...init.payload, binding: init.binding },
  };
  const run = runOf(h, { causationId: envelope.id, pending: [] }, envelope, 1);
  const delivery: Delivery = { envelope, attempt: 1, signal: run.signal, piece: h.id };

  return inRun(h, run, async () => fn(delivery)) as Promise<Awaited<R>>;
}

function fetchHost(h: Harness, auth: unknown): HttpHost {
  return {
    mode: 'dev',
    log: h.log,
    auth: { value: auth },
    idempotency: h.idempotency,
    freshTraceId: () => crypto.randomUUID(),
    invoke: (_piece, init, fn) => invokeEntry(h, init, fn),
    request: (contract, input) => tracked(currentScope(h), answer(h, contract, input)),
  };
}

function targetsOf(h: Harness, piece: PieceClass, instance: object): IngressTarget[] {
  return ingressTargets(h.id, piece, () => instance);
}

function emittedOf(h: Harness, contract?: EventClass): readonly unknown[] {
  if (contract === undefined) {
    return [...h.emitted];
  }

  return h.emitted.filter((e) => e.contract.wireName === contract.wireName).map((e) => e.payload);
}

function requestedOf(h: Harness, contract: RequestClass): readonly unknown[] {
  return h.requested.filter((r) => r.contract.wireName === contract.wireName).map((r) => r.input);
}

function fakedJobs(needs: Readonly<Record<string, unknown>>): JobRecords | undefined {
  return Object.values(needs)
    .map(jobRecordsOf)
    .find((found) => found !== undefined);
}

function recordsIn(piece: PieceClass, needs: Readonly<Record<string, unknown>>): JobRecords {
  const records = fakedJobs(needs);
  if (records === undefined) {
    throw new MurmurError(
      `testPiece: ${piece.name} has no faked jobs need; declare needs: { jobs } and leave it out of options.needs so testPiece records the enqueues`,
      { code: 'test-jobs-unfaked', retryable: false },
    );
  }

  return records;
}

async function resetJobs(needs: Readonly<Record<string, unknown>>): Promise<void> {
  const records = fakedJobs(needs);
  if (records !== undefined) {
    await clearJobs(records);
  }
}

function enqueuedOf(piece: PieceClass, needs: Readonly<Record<string, unknown>>, contract: CommandClass) {
  return recordedJobs(recordsIn(piece, needs))
    .filter((job) => job.contract.wireName === contract.wireName)
    .map((job) => ({ input: job.input, options: job.options }));
}

function isDue(h: Harness, job: RecordedJob): boolean {
  const runAt = job.options.runAt;

  return runAt === undefined || Temporal.Instant.compare(runAt, h.clock.now()) <= 0;
}

function handles(h: Harness, contract: ContractClass): boolean {
  return h.handlers.some((entry) => entry.contract.wireName === contract.wireName);
}

async function runJobs(h: Harness, instance: object, records: JobRecords): Promise<RanJobs> {
  const due = pendingJobs(records).filter((job) => isDue(h, job) && handles(h, job.contract));
  if (due.length === 0) {
    return { ran: 0 };
  }

  await inSequence(due, async (job) => {
    await markRan(records, job);
    await deliver(h, instance, job.contract, job.input, { envelopeId: job.id });
  });

  const more = await runJobs(h, instance, records);

  return { ran: due.length + more.ran };
}

async function classTestPiece<P extends PieceClass>(piece: P, options: ClassOptions): Promise<TestPiece<P>> {
  const h = createHarness(piece, options);
  const needs = await provisionNeeds(h, piece, options.needs ?? {});
  const instance = constructPiece(piece, portOf(h, piece, options, needs));
  const targets = targetsOf(h, piece, instance);
  const router = createRouter(targets, servedSettings(targets, [piece]));
  let started = false;
  let stopped = false;
  const start = async () => {
    started = true;
    await runHook(h, instance, 'onStart');
  };
  const stop = async () => {
    stopped = true;
    await runHook(h, instance, 'onStop');
  };

  return {
    piece: instance,
    needs: needs as NeedsOf<P>,
    log: h.log,
    clock: h.clock,
    ids: h.ids,
    start,
    stop,
    deliver: (contract, input, deliverOptions) =>
      deliver(h, instance, contract, input, deliverOptions) as never,
    deliverJson: (contract, value, deliverOptions) =>
      deliver(h, instance, contract, value, deliverOptions) as never,
    emitted: ((contract?: EventClass) => emittedOf(h, contract)) as TestPiece<P>['emitted'],
    requested: (contract) => requestedOf(h, contract) as never,
    enqueued: (contract) => enqueuedOf(piece, needs, contract) as never,
    runJobs: () => runJobs(h, instance, recordsIn(piece, needs)),
    respond: (contract, responder) => {
      h.responders.set(contract.wireName, responder as Responder);
    },
    fetch: (request, fetchOptions = {}) => {
      const auth = 'auth' in fetchOptions ? fetchOptions.auth : options.auth;

      return handleHttp(request, router, fetchHost(h, auth));
    },
    reset: async () => {
      h.emitted.length = 0;
      h.requested.length = 0;
      h.log.records.length = 0;
      await resetJobs(needs);
    },
    [Symbol.asyncDispose]: async () => {
      if (started && !stopped) {
        await stop();
      }
    },
  };
}

export function testPiece<P extends PieceClass>(
  piece: P,
  ...options: OptionsArgument<TestPieceOptions<P>>
): Promise<TestPiece<P>> {
  return classTestPiece(piece, (options[0] ?? {}) as ClassOptions);
}
