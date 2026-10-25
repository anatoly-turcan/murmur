import { relative } from 'node:path';

import { validatePieceId } from 'murmur';

import type { YamlConfig } from './app-files.ts';
import { isWithin, pieceNodes } from './discover.ts';
import { pieceEnvName, sharedEnvName } from './env-names.ts';
import type { Lanes } from './lanes.ts';
import { configuredGuards, ROUTE_ERROR_CODES } from './routes.ts';
import type { StaticAnalysis } from './statics.ts';
import type {
  CapabilityView,
  Catalog,
  CatalogError,
  CatalogErrorCode,
  CatalogWarning,
  ConfigKeyInfo,
  ConfigView,
  ContractInfo,
  ContractKind,
  ContractView,
  FolderNode,
  PieceInfo,
  PieceKind,
  PieceView,
  Repo,
  RepoDescription,
  TreeNode,
} from './types.ts';

export interface CatalogInput {
  readonly repo: Repo;
  readonly description: RepoDescription;
  readonly yaml: YamlConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly statics: StaticAnalysis;
}

type MutableContract = Omit<ContractView, 'emitters' | 'requesters' | 'enqueuers' | 'handlers'> & {
  emitters: string[];
  requesters: string[];
  enqueuers: string[];
  handlers: string[];
};

export function rejectableLabel(contract: Pick<ContractInfo, 'schema'>): string | null {
  const title = (contract.schema?.reply as { title?: unknown } | undefined)?.title;

  return typeof title === 'string' && title.startsWith('rejectable(') ? title : null;
}

export function sendersOf(contract: ContractView): string[] {
  return [...new Set([...contract.emitters, ...contract.requesters, ...contract.enqueuers])];
}

const external = (capability: string) => `(external: ${capability})`;
const scheduleLabel = (every: string) => `(every ${every})`;
const isExternal = (emitter: string) => emitter.startsWith('(external: ');

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

function rel(repo: Repo, file: string): string {
  return relative(repo.root, file);
}

function contractTable(input: CatalogInput): Map<string, MutableContract> {
  const { repo, description } = input;
  const table = new Map<string, MutableContract>();

  for (const c of description.contracts) {
    table.set(c.name, {
      name: c.name,
      kind: c.kind,
      className: c.className,
      hasReply: c.hasReply,
      visibility: c.visibility,
      scope: c.scope,
      file: rel(repo, c.file),
      emitters: [],
      requesters: [],
      enqueuers: [],
      handlers: [],
      schema: c.schema,
    });
  }

  return table;
}

function undeclaredKind(hasReply: boolean): ContractKind {
  return hasReply ? 'command' : 'event';
}

function entry(table: Map<string, MutableContract>, name: string, hasReply: boolean): MutableContract {
  const existing = table.get(name);
  if (existing !== undefined) {
    return existing;
  }

  const created: MutableContract = {
    name,
    kind: undeclaredKind(hasReply),
    className: name,
    hasReply,
    visibility: 'public',
    scope: null,
    file: '',
    emitters: [],
    requesters: [],
    enqueuers: [],
    handlers: [],
    schema: null,
  };
  table.set(name, created);

  return created;
}

function guardRequesters(input: CatalogInput): [string, string][] {
  const tokens = configuredGuards(input.statics.app);
  const defaults = tokens.flatMap((token) =>
    token.guards.map((guard): [string, string] => [guard, `(${token.name} defaults)`]),
  );
  const routeGuards = input.statics.routes.routes.flatMap((route) => {
    const byDefault = tokens.find((token) => token.name === route.token)?.guards ?? [];

    return route.guards
      .filter((guard) => !byDefault.includes(guard))
      .map((guard): [string, string] => [guard, route.piece]);
  });

  return [...defaults, ...routeGuards];
}

function contractViews(input: CatalogInput): ContractView[] {
  const table = contractTable(input);
  for (const piece of input.description.pieces) {
    for (const name of piece.emits) {
      addUnique(entry(table, name, false).emitters, piece.id);
    }

    for (const name of piece.requests ?? []) {
      addUnique(entry(table, name, true).requesters, piece.id);
    }

    for (const name of piece.jobs ?? []) {
      addUnique(entry(table, name, true).enqueuers, piece.id);
    }

    for (const h of piece.handlers) {
      addUnique(entry(table, h.contract, h.hasReply).handlers, piece.id);

      if (h.every !== undefined) {
        addUnique(entry(table, h.contract, true).enqueuers, scheduleLabel(h.every));
      }
    }
  }

  for (const [name, by] of guardRequesters(input)) {
    addUnique(entry(table, name, true).requesters, by);
  }

  for (const capability of input.description.capabilities) {
    for (const name of capability.emits) {
      addUnique(entry(table, name, false).emitters, external(capability.name));
    }
  }

  return [...table.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

function configSource(input: CatalogInput, id: string, key: ConfigKeyInfo): ConfigView['source'] {
  if (input.env[pieceEnvName(id, key.key)] !== undefined || input.env[sharedEnvName(key.key)] !== undefined) {
    return 'env';
  }

  if (input.yaml.pieces[id]?.[key.key] !== undefined || input.yaml.shared[key.key] !== undefined) {
    return 'yaml';
  }

  return key.hasDefault ? 'default' : 'missing';
}

function hasTests(node: FolderNode): boolean {
  return node.files.some((f) => f.endsWith('.test.ts'));
}

function pieceKind(info: PieceInfo | undefined): PieceKind {
  const serves = (info?.serves ?? []).length + (info?.unresolvedServes ?? 0) > 0;
  const handles = (info?.handlers ?? []).length > 0;

  if (serves && handles) {
    return 'mixed';
  }

  return serves ? 'edge' : 'domain';
}

function pieceView(input: CatalogInput, node: FolderNode, info: PieceInfo | undefined): PieceView {
  return {
    name: node.id,
    className: info?.className ?? null,
    kind: pieceKind(info),
    title: node.title,
    summary: node.summary,
    dir: rel(input.repo, node.dir),
    parent: node.parent === '' ? null : node.parent,
    depth: node.depth,
    children: node.children,
    needs: info?.needs ?? [],
    needFields: info?.needFields ?? [],
    emits: info?.emits ?? [],
    handles: info?.handlers.map((h) => h.contract) ?? [],
    serves: (info?.serves ?? []).map((serve) => serve.key),
    requests: info?.requests ?? [],
    schedules: (info?.handlers ?? []).flatMap((h) =>
      h.every === undefined ? [] : [`${h.contract} every ${h.every}`],
    ),
    config: (info?.config ?? []).map((key) => ({
      key: key.key,
      type: key.type,
      source: configSource(input, node.id, key),
      env: pieceEnvName(node.id, key.key),
    })),
    policy: info?.policy ?? {},
    hasContextMd: node.contextFile !== null,
    hasTests: hasTests(node),
  };
}

function treeOf(repo: Repo, id: string): TreeNode {
  const node = repo.folders.get(id) as FolderNode;

  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    summary: node.summary,
    children: node.children.map((child) => treeOf(repo, child)),
  };
}

function routeCount(input: CatalogInput, name: string): number {
  return input.statics.routes.routes.filter((route) => route.token === name).length;
}

function capabilityViews(input: CatalogInput): CapabilityView[] {
  return input.description.capabilities
    .map((c) => ({
      name: c.name,
      kind: c.kind,
      origin: c.origin,
      usedBy: input.description.pieces.filter((p) => p.needs.includes(c.name)).map((p) => p.id),
      ...(c.kind === 'ingress' ? { routes: c.routes + routeCount(input, c.name) } : {}),
    }))
    .filter((c) => c.origin !== 'builtin' || c.usedBy.length > 0)
    .map(({ origin: _origin, ...view }) => view);
}

function flowWarnings(contract: ContractView): CatalogWarning[] {
  const { name, handlers } = contract;
  const emitters = sendersOf(contract);

  if (contract.kind === 'guard' && handlers.length === 0) {
    return [];
  }

  if (handlers.length > 0 && emitters.length === 0) {
    const message = `${name} is handled but nothing emits it`;

    return [{ code: 'subscribed-never-emitted', subject: name, pieces: handlers, message }];
  }

  if (emitters.length === 0 || handlers.length > 0) {
    return [];
  }

  const pieces = emitters.filter((e) => !isExternal(e));
  if (contract.hasReply) {
    return [
      {
        code: 'requested-never-handled',
        subject: name,
        pieces,
        message: `${name} is requested but has no responder`,
      },
    ];
  }

  return [
    {
      code: 'emitted-never-subscribed',
      subject: name,
      pieces,
      message: `${name} is emitted but nothing handles it`,
    },
  ];
}

function folderWarnings(repo: Repo): CatalogWarning[] {
  return [...repo.folders.values()].flatMap((node): CatalogWarning[] => {
    if (node.id === '') {
      return [];
    }

    const found: CatalogWarning[] = [];
    const subject = node.id;

    if (node.kind === 'piece' && node.contextFile === null) {
      found.push({
        code: 'missing-context-md',
        subject,
        pieces: [subject],
        message: `${subject} has no context.md`,
      });
    }

    if (node.contextFile !== null && node.summary === null) {
      const message = `${subject}/context.md has no frontmatter summary`;
      found.push({ code: 'missing-summary', subject, pieces: [subject], message });
    }

    if (node.kind === 'piece' && !hasTests(node)) {
      found.push({
        code: 'missing-tests',
        subject,
        pieces: [subject],
        message: `${subject} has no *.test.ts`,
      });
    }

    return found;
  });
}

function pieceIdErrors(repo: Repo): CatalogError[] {
  return pieceNodes(repo).flatMap((node) => {
    try {
      validatePieceId(node.id);

      return [];
    } catch (error) {
      return [
        {
          code: 'piece-id' as const,
          message: (error as Error).message,
          file: rel(repo, node.pieceFile as string),
        },
      ];
    }
  });
}

function describeErrors(input: CatalogInput): CatalogError[] {
  return input.description.errors.flatMap((e) =>
    e.code === 'not-a-piece' ? [] : [{ code: e.code, message: e.message, file: rel(input.repo, e.file) }],
  );
}

function contractWarnings(contracts: readonly ContractView[]): CatalogWarning[] {
  return contracts.flatMap(flowWarnings);
}

const STATIC_ERRORS = new Set<CatalogErrorCode>([
  'wire-name',
  'contract-identity',
  'internal-contract-scope',
  'one-piece-per-folder',
]);

function staticErrors(input: CatalogInput): CatalogError[] {
  const { repo, statics } = input;
  const fromFindings = statics.findings
    .filter((f) => STATIC_ERRORS.has(f.rule as CatalogErrorCode))
    .map((f) => ({ code: f.rule as CatalogErrorCode, message: f.message, file: rel(repo, f.file) }));
  const fromRoutes = statics.routes.problems
    .filter((p) => ROUTE_ERROR_CODES.has(p.code))
    .map((p) => ({
      code: p.code as CatalogErrorCode,
      message: p.message,
      file: rel(repo, p.file),
      subject: p.subject,
      pieces: p.pieces,
    }));

  return [...fromFindings, ...fromRoutes];
}

function routeWarnings(input: CatalogInput): CatalogWarning[] {
  return input.statics.routes.problems.flatMap((p) => {
    if (p.code !== 'route-family-split' && p.code !== 'guard-never-handled') {
      return [];
    }

    return [{ code: p.code, subject: p.subject, pieces: p.pieces, message: p.message }];
  });
}

export function deriveCatalog(input: CatalogInput): Catalog {
  const { repo, description } = input;
  const contracts = contractViews(input);
  const infos = new Map(description.pieces.map((p) => [p.id, p]));
  const root = repo.folders.get('');

  return {
    contracts,
    pieces: pieceNodes(repo).map((node) => pieceView(input, node, infos.get(node.id))),
    tree: (root?.children ?? []).map((id) => treeOf(repo, id)),
    capabilities: capabilityViews(input),
    routes: input.statics.routes.routes,
    warnings: [...contractWarnings(contracts), ...routeWarnings(input), ...folderWarnings(repo)],
    errors: [...pieceIdErrors(repo), ...describeErrors(input), ...staticErrors(input)],
  };
}

function orphanWarnings(contract: ContractView): CatalogWarning[] {
  if (contract.file === '' || sendersOf(contract).length > 0 || contract.handlers.length > 0) {
    return [];
  }

  return [
    {
      code: 'orphan-contract',
      subject: contract.name,
      pieces: [],
      message: `${contract.name} is declared in ${contract.file} but nothing emits or handles it`,
    },
  ];
}

export function withStrictWarnings(catalog: Catalog): Catalog {
  return { ...catalog, warnings: [...catalog.warnings, ...catalog.contracts.flatMap(orphanWarnings)] };
}

function inGroup(id: string, group: string): boolean {
  return isWithin(id, group);
}

export function filterCatalog(catalog: Catalog, filter: { group?: string; contract?: string }): Catalog {
  const { group, contract } = filter;
  let contracts = catalog.contracts;
  let pieces = catalog.pieces;

  if (group !== undefined) {
    pieces = pieces.filter((p) => inGroup(p.name, group));
    contracts = contracts.filter(
      (c) =>
        [...sendersOf(c), ...c.handlers].some((id) => inGroup(id, group)) ||
        (c.scope !== null && inGroup(c.scope, group)),
    );
  }

  if (contract !== undefined) {
    contracts = contracts.filter((c) => c.name === contract);
    const involved = new Set(contracts.flatMap((c) => [...sendersOf(c), ...c.handlers]));
    pieces = pieces.filter((p) => involved.has(p.name));
  }

  const names = new Set([...contracts.map((c) => c.name), ...pieces.map((p) => p.name)]);

  const pieceNames = new Set(pieces.map((p) => p.name));

  return {
    ...catalog,
    contracts,
    pieces,
    routes: catalog.routes.filter((route) => pieceNames.has(route.piece)),
    warnings: catalog.warnings.filter((w) => names.has(w.subject) || w.pieces.some((p) => names.has(p))),
  };
}

const FLOW_CODES = new Set<CatalogWarning['code']>([
  'subscribed-never-emitted',
  'emitted-never-subscribed',
  'requested-never-handled',
]);

function withMember(list: readonly string[], id: string, member: boolean): readonly string[] {
  return member && !list.includes(id) ? [...list, id] : list;
}

function withPiece(contract: ContractView, id: string, lanes: Lanes): ContractView {
  const requests = lanes.requests.includes(contract.name);

  return {
    ...contract,
    handlers: withMember(contract.handlers, id, lanes.listens.includes(contract.name)),
    emitters: withMember(contract.emitters, id, lanes.emits.includes(contract.name)),
    requesters: withMember(contract.requesters, id, requests && !contract.emitters.includes(id)),
  };
}

export function withLanes(catalog: Catalog, id: string, lanes: Lanes): Catalog {
  const contracts = catalog.contracts.map((c) => withPiece(c, id, lanes));

  return {
    ...catalog,
    contracts,
    warnings: [...contractWarnings(contracts), ...catalog.warnings.filter((w) => !FLOW_CODES.has(w.code))],
  };
}
