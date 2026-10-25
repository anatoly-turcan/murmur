import { resolve } from 'node:path';

import {
  classPieceRuntime,
  createBus,
  LoadError,
  systemClock,
  type Bus,
  type Clock,
  type DeliveryPolicyInput,
  type IngressPort,
  type PieceRuntime,
  type Registration,
  type Transport,
} from 'murmur';

import { loadAppDefinition, resolveTransport, type AppDefinition } from './app.ts';
import { overridableClock, OVERRIDABLE_IN_PROD, type OverridableClock } from './capabilities/clock.ts';
import { systemIds } from './capabilities/ids.ts';
import { createLogFactory, levelOf, sinkFor, type LogFactory } from './capabilities/log.ts';
import { startCapabilities, type CapabilityStacks, type PlannedCapability } from './capabilities/registry.ts';
import { asDatabase } from './capabilities/sqlite.ts';
import type { Env } from './config/sources.ts';
import { constructPieces, instanceOf } from './construct.ts';
import { current, runContext } from './context.ts';
import { ingressPort } from './ingress.ts';
import { loadApp, type LoadResult, type PieceDraft } from './loader/load.ts';
import { BootFailedError, reportWith } from './loader/report.ts';
import { inSequence } from './sequence.ts';
import { installSignals } from './signals.ts';
import { createSysPublisher, type SysPublisher } from './sys.ts';
import { withTap } from './tap.ts';
import type { BootReport, LoadedPiece, Runtime, RuntimeOptions } from './types.ts';

interface Assembly {
  readonly options: RuntimeOptions;
  readonly loaded: LoadResult;
  readonly transport: Transport;
  readonly bus: Bus;
  readonly sys: SysPublisher;
  readonly logs: LogFactory;
  readonly mode: 'dev' | 'prod';
  readonly clock: Clock;
  readonly override: OverridableClock | undefined;
  readonly stacks: CapabilityStacks;
  readonly instances: Map<string, unknown>;
  readonly pieceInstances: Map<string, object>;
  readonly pieces: readonly LoadedPiece[];
  readonly ready: PromiseWithResolvers<void>;
}

function modeOf(options: RuntimeOptions, env: Env): 'dev' | 'prod' {
  return options.mode ?? (env['MURMUR_ENV'] === 'prod' ? 'prod' : 'dev');
}

function loadFailure(error: LoadError): BootFailedError {
  const report: BootReport = {
    ok: false,
    pieces: [],
    errors: [{ phase: 'load', message: error.message, file: error.file }],
    warnings: [],
    catalog: { contracts: [], capabilities: [] },
  };

  return new BootFailedError(report);
}

async function appOf(options: RuntimeOptions, root: string): Promise<AppDefinition> {
  if (options.app !== undefined) {
    return options.app;
  }

  try {
    return await loadAppDefinition(root);
  } catch (error) {
    throw error instanceof LoadError ? loadFailure(error) : error;
  }
}

function busPolicy(app: AppDefinition, options: RuntimeOptions): DeliveryPolicyInput {
  return { ...app.policy, ...options.policy, retry: { ...app.policy?.retry, ...options.policy?.retry } };
}

function busLimits(app: AppDefinition) {
  const { warnBytes, maxBytes, maxHop } = app.limits ?? {};

  return {
    ...(warnBytes === undefined ? {} : { warnBytes }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(maxHop === undefined ? {} : { maxHop }),
  };
}

async function transportOf(app: AppDefinition, options: RuntimeOptions): Promise<Transport> {
  const transport = await resolveTransport(app);

  return options.tap === undefined ? transport : withTap(transport, options.tap);
}

function runtimeFor(draft: PieceDraft, pieceInstances: Map<string, object>): PieceRuntime {
  const { definition, policy, config, name } = draft;

  return classPieceRuntime({
    name,
    piece: definition.pieceClass,
    instance: () => instanceOf(pieceInstances, name),
    policy,
    configKeys: Object.keys(config),
  });
}

function loadedPieces(loaded: LoadResult, pieceInstances: Map<string, object>): LoadedPiece[] {
  return loaded.pieces.map((draft) => {
    const { policy: _policy, ...rest } = draft;

    return { ...rest, runtime: runtimeFor(draft, pieceInstances) };
  });
}

async function assemble(
  options: RuntimeOptions,
  app: AppDefinition,
  loaded: LoadResult,
  env: Env,
): Promise<Assembly> {
  const mode = modeOf(options, env);
  const override = loaded.clock.overridable ? overridableClock() : undefined;
  const clock = override ?? systemClock;
  const transport = await transportOf(app, options);
  const sink = sinkFor(mode);
  const stacks: CapabilityStacks = {
    ingress: new AsyncDisposableStack(),
    capabilities: new AsyncDisposableStack(),
  };
  const bus = createBus({
    transport,
    context: runContext,
    ids: systemIds,
    clock,
    policy: busPolicy(app, options),
    limits: busLimits(app),
    observability: { payloads: app.observability?.payloads ?? mode === 'dev' },
    mode,
    sink,
    stacks,
  });
  const sys = createSysPublisher({
    transport,
    ids: systemIds,
    clock,
    instanceId: bus.instanceId,
  });
  const logs = createLogFactory({
    sink,
    publish: sys,
    level: levelOf(env, mode),
    mode,
    now: () => clock.now().toString(),
  });
  const instances = new Map<string, unknown>();
  const pieceInstances = new Map<string, object>();

  return {
    options,
    loaded,
    transport,
    bus,
    sys,
    logs,
    mode,
    clock,
    override,
    stacks,
    instances,
    pieceInstances,
    pieces: loadedPieces(loaded, pieceInstances),
    ready: Promise.withResolvers<void>(),
  };
}

function skippedOf(capabilities: readonly PlannedCapability[]): Map<string, string> {
  return new Map(
    capabilities.flatMap((entry) => (entry.off === undefined ? [] : [[entry.name, entry.off] as const])),
  );
}

async function constructAll(assembly: Assembly): Promise<void> {
  const errors = constructPieces(assembly.pieces, {
    bus: assembly.bus,
    logs: assembly.logs,
    clock: assembly.clock,
    ids: systemIds,
    capabilities: assembly.instances,
    skipped: skippedOf(assembly.loaded.capabilities),
    instances: assembly.pieceInstances,
  });

  if (errors.length === 0) {
    return;
  }

  await assembly.bus.stop('construct failed');
  throw new BootFailedError(reportWith(assembly.loaded.report, errors));
}

function registerAll(assembly: Assembly): Promise<Registration[]> {
  return inSequence(assembly.pieces, (piece) => assembly.bus.register(piece.runtime));
}

function ingressOf(assembly: Assembly): IngressPort {
  return ingressPort({
    pieces: assembly.pieces,
    instance: (name) => instanceOf(assembly.pieceInstances, name),
    bus: assembly.bus,
    sys: assembly.sys,
    ready: assembly.ready.promise,
    claimsJobs: assembly.loaded.claimsJobs,
  });
}

function drainMs(assembly: Assembly): number {
  return Math.max(0, ...assembly.pieces.map((piece) => assembly.bus.policyOf(piece.name).timeoutMs));
}

async function attachOverride(assembly: Assembly): Promise<void> {
  const { override, instances, mode, logs } = assembly;
  if (override === undefined) {
    return;
  }

  await override.attach(asDatabase(instances.get('sqlite')));

  if (mode === 'prod') {
    logs.forCurrent('runtime', current).warn(OVERRIDABLE_IN_PROD);
  }
}

async function startAll(assembly: Assembly): Promise<void> {
  const { bus, sys, logs, mode, instances, stacks, loaded, pieces, transport, clock } = assembly;

  await startCapabilities(loaded.capabilities, {
    bus,
    sys,
    logs,
    current,
    clock,
    ids: systemIds,
    mode,
    root: resolve(assembly.options.root),
    instances,
    stacks,
    ingress: ingressOf(assembly),
    drainMs: () => drainMs(assembly),
  });

  await attachOverride(assembly);
  await constructAll(assembly);
  await inSequence(await registerAll(assembly), (registration) => registration.start());
  assembly.ready.resolve();
  sys('runtime.started', {
    pid: process.pid,
    transport: transport.name,
    pieces: pieces.map((p) => p.name),
    capabilities: [...instances.keys()],
    configSummary: Object.fromEntries(pieces.map((p) => [p.name, Object.keys(p.config)])),
  });
}

function runtimeOf(assembly: Assembly): Runtime {
  let started: Promise<void> | undefined;
  let uninstall: (() => void) | undefined;
  const stop = async (reason = 'stop') => {
    uninstall?.();
    await assembly.bus.stop(reason);
  };
  const start = async () => {
    await (started ??= startAll(assembly));

    if (assembly.options.signals === false || uninstall !== undefined) {
      return;
    }

    uninstall = installSignals((reason) => stop(reason).catch(() => {}));
  };

  return {
    bus: assembly.bus,
    clock: assembly.clock,
    pieces: assembly.pieces,
    capabilities: assembly.instances,
    report: assembly.loaded.report,
    start,
    stop,
    [Symbol.asyncDispose]: () => stop('dispose'),
  };
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const root = resolve(options.root);
  const env: Env = options.env ?? process.env;
  const app = await appOf(options, root);

  const loaded = await loadApp({
    root,
    app,
    env,
    configFile: options.configFile,
    process: options.process,
    mode: modeOf(options, env),
  });

  if (!loaded.report.ok) {
    throw new BootFailedError(loaded.report);
  }

  return runtimeOf(await assemble(options, app, loaded, env));
}
