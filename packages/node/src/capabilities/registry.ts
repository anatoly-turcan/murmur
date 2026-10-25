import {
  serializeError,
  type AnyCapabilityDefinition,
  type Capability,
  type CapabilityBus,
  type Clock,
  type Ids,
  type IngressPort,
  type RunContext,
} from 'murmur';

import type { AppCapabilities } from '../app.ts';
import type { ValidPiece } from '../loader/candidate.ts';
import { neededTokens, servedTokens } from '../loader/class-piece.ts';
import { inSequence } from '../sequence.ts';
import type { SysPublisher } from '../sys.ts';
import type { BootError } from '../types.ts';
import { fetch } from './fetch.ts';
import { kv } from './kv.ts';
import type { LogFactory } from './log.ts';
import { sqlite } from './sqlite.ts';

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 2_000;

export interface CapabilityEntry {
  readonly name: string;
  readonly definition: AnyCapabilityDefinition;
  readonly file: string | undefined;
  readonly origin: 'builtin' | 'app' | 'local';
}

export interface PlannedCapability extends CapabilityEntry {
  readonly config: unknown;
  readonly off?: string;
}

export interface LocalCapability {
  readonly file: string;
  readonly definition: AnyCapabilityDefinition;
}

export interface CapabilityStacks {
  readonly ingress: AsyncDisposableStack;
  readonly capabilities: AsyncDisposableStack;
}

export interface StartDeps {
  readonly bus: CapabilityBus;
  readonly sys: SysPublisher;
  readonly logs: LogFactory;
  readonly current: () => RunContext | undefined;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly mode: 'dev' | 'prod';
  readonly root: string;
  readonly instances: Map<string, unknown>;
  readonly stacks: CapabilityStacks;
  readonly ingress?: IngressPort;
  readonly drainMs?: () => number;
}

export function builtinCapabilities(): AnyCapabilityDefinition[] {
  return [sqlite, kv, fetch];
}

function recordEntries(
  app: Readonly<Record<string, AnyCapabilityDefinition>>,
  errors: BootError[],
): CapabilityEntry[] {
  return Object.entries(app).flatMap(([key, definition]) => {
    if (key === definition.name) {
      return [{ name: key, definition, file: undefined, origin: 'app' as const }];
    }

    errors.push({
      phase: 'needs',
      message: `capabilities.${key} defines "${definition.name}": the key must equal the capability name`,
    });

    return [];
  });
}

function listEntries(app: readonly AnyCapabilityDefinition[], errors: BootError[]): CapabilityEntry[] {
  const byName = new Map<string, AnyCapabilityDefinition>();
  for (const definition of app) {
    const listed = byName.get(definition.name);
    if (listed !== undefined && listed !== definition) {
      errors.push({
        phase: 'needs',
        message: `capabilities lists two different capabilities named ${definition.name}`,
      });
    }

    byName.set(definition.name, listed ?? definition);
  }

  return [...byName.values()].map((definition) => ({
    name: definition.name,
    definition,
    file: undefined,
    origin: 'app' as const,
  }));
}

function appEntries(app: AppCapabilities, errors: BootError[]): CapabilityEntry[] {
  if (Array.isArray(app)) {
    return listEntries(app, errors);
  }

  return recordEntries(app as Readonly<Record<string, AnyCapabilityDefinition>>, errors);
}

export function collectCapabilities(
  app: AppCapabilities | undefined,
  local: readonly LocalCapability[],
): { entries: Map<string, CapabilityEntry>; errors: BootError[] } {
  const errors: BootError[] = [];
  const entries = new Map<string, CapabilityEntry>(
    builtinCapabilities().map((definition) => [
      definition.name,
      { name: definition.name, definition, file: undefined, origin: 'builtin' },
    ]),
  );

  for (const entry of appEntries(app ?? {}, errors)) {
    entries.set(entry.name, entry);
  }

  for (const { file, definition } of local) {
    const existing = entries.get(definition.name);
    if (existing !== undefined && existing.origin !== 'builtin') {
      errors.push({
        phase: 'needs',
        message: `capability ${definition.name} is defined twice (${existing.file ?? 'murmur.config.ts'}, ${file})`,
        file,
      });
    } else {
      entries.set(definition.name, { name: definition.name, definition, file, origin: 'local' });
    }
  }

  return { entries, errors };
}

function tokenMismatch(
  piece: ValidPiece,
  token: Capability,
  entry: CapabilityEntry,
  verb: string,
): BootError {
  const where = entry.file ?? (entry.origin === 'builtin' ? 'the built-in' : 'murmur.config.ts');

  return {
    phase: 'needs',
    message: `${piece.id} ${verb} a capability named ${token.name} that is not the one registered by ${where}: import that token`,
    file: piece.file,
  };
}

function addToken(
  entries: Map<string, CapabilityEntry>,
  piece: ValidPiece,
  token: Capability,
  verb: string,
): void {
  const entry = entries.get(token.name);
  if (entry === undefined) {
    entries.set(token.name, {
      name: token.name,
      definition: token as unknown as AnyCapabilityDefinition,
      file: undefined,
      origin: 'app',
    });
  } else if (entry.definition !== (token as unknown)) {
    piece.errors.push(tokenMismatch(piece, token, entry, verb));
  }
}

export function addNeededTokens(entries: Map<string, CapabilityEntry>, pieces: readonly ValidPiece[]): void {
  for (const piece of pieces) {
    for (const token of neededTokens(piece.definition)) {
      addToken(entries, piece, token, 'needs');
    }

    for (const token of servedTokens(piece.definition)) {
      addToken(entries, piece, token, 'serves through');
    }
  }
}

function levels(
  entries: ReadonlyMap<string, CapabilityEntry>,
  names: ReadonlySet<string>,
): Map<string, number> {
  const memo = new Map<string, number>();
  const level = (name: string): number => {
    const known = memo.get(name);
    if (known !== undefined) {
      return known;
    }

    const needs = (entries.get(name)?.definition.needs ?? []).filter((n) => names.has(n));
    const value = needs.length === 0 ? 0 : 1 + Math.max(...needs.map(level));
    memo.set(name, value);

    return value;
  };

  for (const name of names) {
    level(name);
  }

  return memo;
}

export function planCapabilities(
  entries: ReadonlyMap<string, CapabilityEntry>,
  roots: readonly string[],
): { order: CapabilityEntry[]; errors: BootError[] } {
  const done = new Set<string>();
  const errors: BootError[] = [];
  const visit = (name: string, path: readonly string[]): void => {
    if (path.includes(name)) {
      errors.push({ phase: 'needs', message: `capability cycle: ${[...path, name].join(' → ')}` });

      return;
    }

    if (done.has(name)) {
      return;
    }

    const entry = entries.get(name);
    if (entry === undefined) {
      errors.push({ phase: 'needs', message: `capability ${path.at(-1)} needs unknown capability ${name}` });

      return;
    }

    for (const dependency of entry.definition.needs ?? []) {
      visit(dependency, [...path, name]);
    }

    done.add(name);
  };
  const ingress = [...entries.values()].filter((e) => e.definition.ingress === true).map((e) => e.name);

  for (const name of [...roots, ...ingress]) {
    visit(name, []);
  }

  if (errors.length > 0) {
    return { order: [], errors };
  }

  const depth = levels(entries, done);
  const order = [...done]
    .toSorted((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0) || a.localeCompare(b))
    .flatMap((name) => entries.get(name) ?? []);

  return { order, errors };
}

function withTimeout<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });

  return Promise.race([work, promise]).finally(() => signal.removeEventListener('abort', onAbort));
}

function once(work: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;

  return () => (running ??= work());
}

function stopBudget(entry: PlannedCapability, deps: StartDeps): number {
  if (entry.definition.ingress !== true || deps.drainMs === undefined) {
    return STOP_TIMEOUT_MS;
  }

  return Math.max(STOP_TIMEOUT_MS, deps.drainMs());
}

async function stopOne(entry: PlannedCapability, instance: unknown, deps: StartDeps): Promise<void> {
  const started = performance.now();

  try {
    await entry.definition.stop?.(instance as never, AbortSignal.timeout(stopBudget(entry, deps)));
    deps.sys('capability.stopped', { name: entry.name, durationMs: Math.round(performance.now() - started) });
  } catch (error) {
    deps.sys('capability.failed', {
      name: entry.name,
      phase: 'stop',
      error: serializeError(error, deps.mode === 'dev'),
    });
    throw error;
  }
}

async function startOne(entry: PlannedCapability, deps: StartDeps): Promise<void> {
  const started = performance.now();
  const signal = AbortSignal.timeout(START_TIMEOUT_MS);
  const needs = Object.fromEntries(
    (entry.definition.needs ?? []).map((name) => [name, deps.instances.get(name)]),
  );
  const context = {
    config: entry.config,
    needs,
    bus: deps.bus,
    log: deps.logs.forCurrent(`capability:${entry.name}`, deps.current),
    clock: deps.clock,
    ids: deps.ids,
    mode: deps.mode,
    signal,
    root: deps.root,
    ingress: deps.ingress,
  };

  const instance = await withTimeout(
    Promise.try(() => entry.definition.start(context as never)),
    signal,
  );

  deps.instances.set(entry.name, instance);
  deps.sys('capability.started', { name: entry.name, durationMs: Math.round(performance.now() - started) });
  const stop = once(() => stopOne(entry, instance, deps));
  deps.stacks.capabilities.defer(stop);

  if (entry.definition.ingress === true) {
    deps.stacks.ingress.defer(stop);
  }
}

async function startGuarded(entry: PlannedCapability, deps: StartDeps): Promise<void> {
  try {
    await startOne(entry, deps);
  } catch (error) {
    deps.sys('capability.failed', {
      name: entry.name,
      phase: 'start',
      error: serializeError(error, deps.mode === 'dev'),
    });
    await deps.stacks.capabilities.disposeAsync();
    throw nameCapability(error, entry.name);
  }
}

function nameCapability(error: unknown, name: string): unknown {
  if (error instanceof Error && !Reflect.has(error, 'capability')) {
    Reflect.set(error, 'capability', name);
  }

  return error;
}

function skipOff(entry: PlannedCapability, deps: StartDeps): Promise<void> {
  const log = deps.logs.forCurrent(`capability:${entry.name}`, deps.current);
  log.info(`${entry.name} not started: ${entry.off}`, { capability: entry.name, reason: entry.off });

  return Promise.resolve();
}

export async function startCapabilities(order: readonly PlannedCapability[], deps: StartDeps): Promise<void> {
  await inSequence(order, (entry) =>
    entry.off === undefined ? startGuarded(entry, deps) : skipOff(entry, deps),
  );
}
