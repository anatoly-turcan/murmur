import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isContract, type ContractClass } from 'murmur';

import { resolveLimits } from './limits.ts';
import type {
  CapabilityInfo,
  ContractFile,
  ContractInfo,
  DescribeError,
  FileError,
  PieceInfo,
  ProcessView,
  RepoDescription,
} from './types.ts';

export interface DescribeInput {
  readonly root: string;
  readonly pieces: readonly { readonly id: string; readonly file: string }[];
  readonly contractFiles: readonly ContractFile[];
  readonly capabilityFiles: readonly string[];
}

interface State {
  readonly input: DescribeInput;
  readonly importErrors: FileError[];
  readonly errors: DescribeError[];
  readonly classes: ContractInfo[];
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function importFile(state: State, file: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (error) {
    state.importErrors.push({ file, message: message(error) });

    return null;
  }
}

function classSchema(value: ContractClass): Pick<ContractInfo, 'schema' | 'schemaError'> {
  try {
    const json = value.jsonSchema();
    if (json.output === undefined) {
      return { schema: { payload: json.input }, schemaError: null };
    }

    return { schema: { payload: json.input, reply: json.output }, schemaError: null };
  } catch (error) {
    return { schema: null, schemaError: message(error) };
  }
}

function runtimeName(value: ContractClass): string | null {
  try {
    return value.wireName;
  } catch {
    return null;
  }
}

function rememberClass(state: State, source: ContractFile, exportName: string, value: ContractClass): void {
  const name = runtimeName(value);
  if (name === null) {
    return;
  }

  state.classes.push({
    name,
    exportName,
    file: source.file,
    visibility: source.visibility,
    scope: source.scope,
    hasReply: value.kind !== 'event',
    kind: value.kind,
    className: value.name,
    runtimeName: name,
    ...classSchema(value),
  });
}

async function describeContracts(state: State): Promise<void> {
  for (const source of state.input.contractFiles) {
    const module = await importFile(state, source.file);
    for (const [exportName, value] of Object.entries(module ?? {})) {
      if (isContract(value)) {
        rememberClass(state, source, exportName, value);
      }
    }
  }
}

async function loadApp(state: State): Promise<{ app: Record<string, unknown> | null; error: string | null }> {
  try {
    const module = (await import(pathToFileURL(join(state.input.root, 'murmur.config.ts')).href)) as {
      default?: unknown;
    };

    const app = module.default;
    if (typeof app !== 'object' || app === null) {
      return { app: null, error: 'murmur.config.ts has no default export' };
    }

    return { app: app as Record<string, unknown>, error: null };
  } catch (error) {
    return { app: null, error: message(error) };
  }
}

interface CapabilityLike {
  readonly name?: unknown;
  readonly ingress?: unknown;
  readonly docs?: unknown;
  readonly emits?: unknown;
  readonly requests?: unknown;
}

function capabilityInfo(
  value: CapabilityLike,
  origin: CapabilityInfo['origin'],
  file: string | null,
): CapabilityInfo | null {
  if (typeof value.name !== 'string') {
    return null;
  }

  const contracts = [value.emits, value.requests].flatMap((list) => (Array.isArray(list) ? list : []));

  return {
    name: value.name,
    kind: value.ingress === true ? 'ingress' : 'handle',
    origin,
    file,
    docs: typeof value.docs === 'string' ? value.docs : null,
    emits: contracts.filter(isContract).map((c) => c.wireName),
    routes: contracts.length,
  };
}

async function builtinCapabilities(root: string): Promise<CapabilityInfo[]> {
  const names = ['sqlite', 'kv', 'fetch', 'jobs'];

  try {
    const url = createRequire(join(root, 'package.json')).resolve('@murmur/node/capabilities');
    const module = (await import(pathToFileURL(url).href)) as Record<string, () => CapabilityLike>;

    return names.flatMap((name) => capabilityInfo(module[name]?.() ?? { name }, 'builtin', null) ?? []);
  } catch {
    return names.flatMap((name) => capabilityInfo({ name }, 'builtin', null) ?? []);
  }
}

async function localCapabilities(state: State): Promise<CapabilityInfo[]> {
  const found: CapabilityInfo[] = [];
  for (const file of state.input.capabilityFiles) {
    const module = await importFile(state, file);
    const info = capabilityInfo((module?.['default'] ?? {}) as CapabilityLike, 'local', file);
    const docsFile = join(file, '..', 'capability.md');

    if (info !== null) {
      found.push({ ...info, docs: info.docs ?? readOptional(docsFile) });
    }
  }

  return found;
}

function readOptional(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

async function describeCapabilities(
  state: State,
  app: Record<string, unknown> | null,
): Promise<CapabilityInfo[]> {
  const byName = new Map<string, CapabilityInfo>();
  for (const info of await builtinCapabilities(state.input.root)) {
    byName.set(info.name, info);
  }

  const declared = (app?.['capabilities'] ?? {}) as Record<string, CapabilityLike>;
  for (const value of Object.values(declared)) {
    const info = capabilityInfo(value, 'app', null);
    if (info !== null) {
      byName.set(info.name, info);
    }
  }

  for (const info of await localCapabilities(state)) {
    byName.set(info.name, info);
  }

  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

function emptyPiece(id: string, file: string, error: string | null): PieceInfo {
  return {
    id,
    file,
    error,
    hasPieceClass: false,
    handlers: [],
    emits: [],
    needs: [],
    config: [],
    policy: {},
  };
}

async function describePiece(state: State, id: string, file: string): Promise<PieceInfo> {
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    return emptyPiece(id, file, message(error));
  }

  state.errors.push({
    code: 'not-a-piece',
    message: `${id}: piece.ts must export one piece class (export class Todos extends Piece({ … }))`,
    file,
  });

  return emptyPiece(id, file, null);
}

function processView(name: string, entry: unknown): ProcessView {
  const pieces: unknown = Reflect.get(Object(entry), 'pieces');
  const globs = Array.isArray(pieces) ? pieces.filter((glob) => typeof glob === 'string') : [];

  return { name, globs };
}

function processesOf(app: Record<string, unknown> | null): ProcessView[] | null {
  const processes = app?.['processes'];
  if (typeof processes !== 'object' || processes === null) {
    return null;
  }

  return Object.entries(processes).map(([name, entry]) => processView(name, entry));
}

function transportOf(root: string, app: Record<string, unknown> | null): RepoDescription['transport'] {
  const transport = app?.['transport'];
  if (typeof transport === 'object' && transport !== null) {
    return Reflect.get(transport, 'name') === 'memory' ? 'memory' : 'other';
  }

  const source = readOptional(join(root, 'murmur.config.ts')) ?? '';
  const factories = new Set(source.match(/\bcreate\w*Transport(?=\s*\()/g) ?? []);

  return factories.size === 1 && factories.has('createMemoryTransport') ? 'memory' : 'other';
}

export async function describeInProcess(input: DescribeInput): Promise<RepoDescription> {
  const state: State = { input, importErrors: [], errors: [], classes: [] };
  await describeContracts(state);
  const { app, error } = await loadApp(state);
  const capabilities = await describeCapabilities(state, app);
  const pieces: PieceInfo[] = [];

  for (const { id, file } of input.pieces) {
    pieces.push(await describePiece(state, id, file));
  }

  return {
    pieces,
    contracts: state.classes,
    capabilities,
    appLoaded: app !== null,
    appError: error,
    processes: processesOf(app),
    transport: transportOf(input.root, app),
    limits: resolveLimits(app?.['limits']),
    importErrors: state.importErrors,
    errors: state.errors,
  };
}

process.once('message', (input: DescribeInput) => {
  describeInProcess(input).then(
    (description) => process.send?.({ ok: true, description }, () => process.exit(0)),
    (error: unknown) => process.send?.({ ok: false, error: message(error) }, () => process.exit(0)),
  );
});
