import { join } from 'node:path';

import { devStopPolicy, type BootReport, type EmitRequest, type EmitResponse } from '@murmur/dev-protocol';
import {
  BootFailedError,
  createRuntime,
  describePiece,
  isInternal,
  LoadError,
  loadAppDefinition,
  type AppDefinition,
  type ContractClass,
  type Envelope,
  type EventClass,
  type RequestClass,
  type Runtime,
  type Transport,
} from '@murmur/node';

import { isSystemError, StartFailedError } from './boot-failure.ts';
import type { CallFailure, ChildCall, ChildInit, ChildMessage, ParentMessage } from './ipc.ts';

interface Pausable extends Transport {
  pause(): void;
  resume(): void;
}

const STATUS: Readonly<Record<string, number>> = {
  ContractViolationError: 400,
  NotRequestableError: 400,
  UnknownContractError: 404,
  NoRouteError: 404,
  TransportNotPausableError: 409,
  RequestTimeoutError: 504,
  RemoteError: 502,
};

const init = JSON.parse(process.argv[2] ?? '{}') as ChildInit;
const roots = new Map<string, string | undefined>();
let transport: Transport | undefined;

function send(message: ChildMessage): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (process.send === undefined) {
    resolve();
  } else {
    process.send(message, undefined, {}, () => resolve());
  }

  return promise;
}

function tap(envelope: Envelope): void {
  void send({ t: 'env', envelope });

  if (
    roots.has(envelope.traceId) &&
    roots.get(envelope.traceId) === undefined &&
    !isInternal(envelope.name)
  ) {
    roots.set(envelope.traceId, envelope.id);
  }
}

function captureTransport(app: AppDefinition): AppDefinition {
  const original = app.transport;

  return {
    ...app,
    transport: async () => {
      transport = typeof original === 'function' ? await original() : original;

      return transport;
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadReport(message: string, file?: string): BootReport {
  return {
    ok: false,
    pieces: [],
    errors: [{ phase: 'load', message, ...(file === undefined ? {} : { file }) }],
    warnings: [],
    catalog: { contracts: [], capabilities: [] },
  };
}

function failureReport(error: unknown): BootReport {
  if (error instanceof BootFailedError || error instanceof StartFailedError) {
    return error.report;
  }

  if (error instanceof LoadError) {
    return loadReport(error.message, error.file);
  }

  return loadReport(messageOf(error));
}

async function loadApp(): Promise<AppDefinition> {
  try {
    return await loadAppDefinition(init.root);
  } catch (error) {
    if (error instanceof LoadError) {
      throw error;
    }

    throw new LoadError(join(init.root, 'murmur.config.ts'), 'load', messageOf(error), { cause: error });
  }
}

function namedError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

function contractsOf(runtime: Runtime): Map<string, ContractClass> {
  const contracts = runtime.pieces.flatMap(({ definition: { pieceClass } }) => [
    ...describePiece(pieceClass).handlers.map((handler) => handler.contract),
    ...(pieceClass.declaration.emits ?? []),
  ]);

  return new Map(contracts.map((contract) => [contract.wireName, contract]));
}

function publish(runtime: Runtime, contract: ContractClass, request: EmitRequest): Promise<unknown> {
  const { bus } = runtime;
  const payload = request.payload as never;

  if (request.mode === 'emit') {
    return bus.emit(contract as EventClass, payload).then(() => undefined);
  }

  const options = request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs };

  return bus.request(contract as RequestClass, payload, options);
}

async function emit(runtime: Runtime, request: EmitRequest): Promise<EmitResponse> {
  const contract = contractsOf(runtime).get(request.contract);
  if (contract === undefined) {
    throw namedError('UnknownContractError', `no loaded piece handles or emits ${request.contract}`);
  }

  const traceId = crypto.randomUUID();
  const started = performance.now();
  roots.set(traceId, undefined);

  try {
    const reply = await runtime.bus.enter({ piece: 'external:dev', traceId }, () =>
      publish(runtime, contract, request),
    );

    const durationMs = Math.round(performance.now() - started);

    return {
      traceId,
      envelopeId: roots.get(traceId) ?? '',
      ...(request.mode === 'request' ? { reply } : {}),
      durationMs,
    };
  } finally {
    roots.delete(traceId);
  }
}

function pausable(): Pausable {
  const candidate = transport as Partial<Pausable> | undefined;
  if (candidate?.name !== 'memory' || typeof candidate.pause !== 'function') {
    throw namedError('TransportNotPausableError', 'pause/resume needs the memory transport');
  }

  return candidate as Pausable;
}

function perform(runtime: Runtime, call: ChildCall): Promise<unknown> | unknown {
  if (call.op === 'emit') {
    return emit(runtime, call.request);
  }

  const target = pausable();
  if (call.op === 'pause') {
    target.pause();
  } else {
    target.resume();
  }

  return { paused: call.op === 'pause' };
}

function failure(error: unknown): CallFailure {
  const named = error instanceof Error ? error : new Error(String(error));
  const code = Reflect.get(named, 'code');
  const issues = Reflect.get(named, 'issues');

  return {
    status: STATUS[named.name] ?? 500,
    error: {
      name: named.name,
      message: named.message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(issues === undefined ? {} : { issues }),
    },
  };
}

async function answer(runtime: Runtime, message: ParentMessage): Promise<void> {
  try {
    await send({ t: 'reply', id: message.id, ok: true, value: await perform(runtime, message.call) });
  } catch (error) {
    await send({ t: 'reply', id: message.id, ok: false, ...failure(error) });
  }
}

async function shutdown(runtime: Runtime, reason: string): Promise<void> {
  try {
    await runtime.bus.stop(reason, devStopPolicy);
  } finally {
    await send({ t: 'stopped' });
    process.exit(0);
  }
}

async function boot(): Promise<Runtime> {
  const started = performance.now();
  const app = captureTransport(await loadApp());

  const runtime = await createRuntime({
    root: init.root,
    app,
    mode: 'dev',
    signals: false,
    tap,
    ...(init.process === undefined ? {} : { process: init.process }),
  });

  await runtime.start().catch((error: unknown) => {
    if (error instanceof BootFailedError) {
      throw error;
    }

    throw new StartFailedError(error);
  });

  await send({
    t: 'boot',
    info: {
      app: app.name,
      transport: transport?.name ?? 'unknown',
      startedAt: new Date().toISOString(),
      bootDurationMs: Math.round(performance.now() - started),
      pieces: runtime.pieces.map((piece) => piece.name),
    },
  });

  return runtime;
}

function unexpected(error: unknown): unknown {
  if (error instanceof BootFailedError || error instanceof LoadError) {
    return undefined;
  }

  if (error instanceof StartFailedError) {
    return isSystemError(error.cause) ? undefined : error.cause;
  }

  return error;
}

async function reportFailure(error: unknown): Promise<never> {
  const shown = unexpected(error);
  if (shown !== undefined) {
    process.stderr.write(`${shown instanceof Error ? (shown.stack ?? shown.message) : String(shown)}\n`);
  }

  await send({ t: 'boot_failed', report: failureReport(error) });
  process.exit(4);
}

async function main(): Promise<void> {
  const runtime = await boot().catch(reportFailure);
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) {
      return;
    }

    stopping = true;
    void shutdown(runtime, reason);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('disconnect', () => stop('disconnect'));
  process.on('message', (message: ParentMessage) => void answer(runtime, message));
}

await main();
