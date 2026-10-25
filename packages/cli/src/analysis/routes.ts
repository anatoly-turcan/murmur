import {
  bindingConflicts,
  guardOrderProblem,
  metaKeyProblem,
  routeShadows,
  type BindingConflict,
  type GuardRef,
  type GuardShape,
  type ServedBinding,
} from 'murmur';

import type { StaticApp, StaticContract, StaticToken } from './static-app.ts';
import type { CatalogRoute, PieceInfo, ServeInfo } from './types.ts';

export type RouteProblemCode =
  | 'binding-conflict'
  | 'route-shadowed'
  | 'route-family-split'
  | 'guard-never-handled'
  | 'guard-output-overlap'
  | 'guard-order'
  | 'guard-meta-unknown';

export const ROUTE_ERROR_CODES: ReadonlySet<string> = new Set<RouteProblemCode>([
  'binding-conflict',
  'route-shadowed',
  'guard-output-overlap',
  'guard-order',
  'guard-meta-unknown',
]);

export const ROUTE_RULES: ReadonlySet<string> = new Set([
  ...ROUTE_ERROR_CODES,
  'route-family-split',
  'guard-never-handled',
  'binding-param-not-in-input',
  'idempotent-method',
  'idempotent-scope',
  'serve-unresolved',
  'guard-requested-directly',
]);

export interface RouteProblem {
  readonly code: RouteProblemCode;
  readonly severity: 'error' | 'warn';
  readonly subject: string;
  readonly pieces: readonly string[];
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface RouteAnalysis {
  readonly routes: readonly CatalogRoute[];
  readonly problems: readonly RouteProblem[];
}

interface Served {
  readonly piece: PieceInfo;
  readonly serve: ServeInfo;
}

function servedOf(pieces: readonly PieceInfo[]): Served[] {
  return pieces.flatMap((piece) => (piece.serves ?? []).map((serve) => ({ piece, serve })));
}

function catalogRoute(served: Served): CatalogRoute {
  const { piece, serve } = served;

  return {
    transport: serve.transport,
    token: serve.token,
    key: serve.key,
    piece: piece.id,
    ...(serve.method === null ? {} : { method: serve.method }),
    ...(serve.contract === null ? {} : { contract: serve.contract }),
    ...(serve.status === null ? {} : { status: serve.status }),
    guards: serve.guards,
  };
}

function bindingOf(served: Served): ServedBinding {
  return { piece: served.piece.id, binding: { transport: served.serve.transport, key: served.serve.key } };
}

function located(all: readonly Served[], binding: ServedBinding): Served | undefined {
  return all.find((s) => s.piece.id === binding.piece && s.serve.key === binding.binding.key);
}

function conflictProblem(
  all: readonly Served[],
  code: 'binding-conflict' | 'route-shadowed',
  conflict: BindingConflict,
): RouteProblem {
  const second = located(all, conflict.second);
  const where = code === 'route-shadowed' ? located(all, conflict.first) : second;

  return {
    code,
    severity: 'error',
    subject: conflict.first.binding.key,
    pieces: [...new Set([conflict.first.piece, conflict.second.piece])],
    file: where?.piece.file ?? '',
    line: where?.serve.line ?? 1,
    message: conflict.message,
  };
}

function familyOf(key: string): string {
  const path = key.slice(key.indexOf(' ') + 1);
  const first = path.split('/').find((segment) => segment !== '') ?? '';

  return first.startsWith(':') || first.startsWith('*') ? '/' : `/${first}`;
}

function routeCount(members: readonly Served[], id: string): number {
  return members.filter((m) => m.piece.id === id).length;
}

function familyOwner(members: readonly Served[], pieces: readonly string[]): string {
  const [owner = ''] = pieces.toSorted((a, b) => routeCount(members, b) - routeCount(members, a));

  return owner;
}

function splitProblem(name: string, owner: string, pieces: readonly string[], moved: Served[]): RouteProblem {
  const [first] = moved as [Served, ...Served[]];
  const keys = moved.map((m) => m.serve.key).join(', ');

  return {
    code: 'route-family-split',
    severity: 'warn',
    subject: name,
    pieces: [owner, first.piece.id],
    file: first.piece.file,
    line: first.serve.line,
    message: `the ${name} family is served by ${pieces.join(' and ')}; one edge piece per family (move ${keys} from ${first.piece.id} into ${owner})`,
  };
}

function familyProblems(all: readonly Served[]): RouteProblem[] {
  const families = Map.groupBy(all, (s) => `${s.serve.transport} ${familyOf(s.serve.key)}`);

  return [...families.entries()].flatMap(([family, members]) => {
    const pieces = [...new Set(members.map((m) => m.piece.id))];
    if (pieces.length < 2) {
      return [];
    }

    const name = family.slice(family.indexOf(' ') + 1);
    const owner = familyOwner(members, pieces);
    const ordered = [owner, ...pieces.filter((id) => id !== owner)];

    return ordered.slice(1).map((id) =>
      splitProblem(
        name,
        owner,
        ordered,
        members.filter((m) => m.piece.id === id),
      ),
    );
  });
}

function handled(pieces: readonly PieceInfo[]): Set<string> {
  return new Set(pieces.flatMap((p) => p.handlers.map((h) => h.contract)));
}

function guardProblems(
  all: readonly Served[],
  tokens: readonly ConfiguredGuards[],
  pieces: readonly PieceInfo[],
): RouteProblem[] {
  const responders = handled(pieces);
  const configured = [
    ...tokens.flatMap((t) =>
      t.guards.map((guard) => ({ guard, file: t.file, line: 1, by: `${t.name} defaults` })),
    ),
    ...all.flatMap((s) =>
      s.serve.guards.map((guard) => ({ guard, file: s.piece.file, line: s.serve.line, by: s.piece.id })),
    ),
  ];
  const seen = new Set<string>();

  return configured.flatMap((entry) => {
    if (responders.has(entry.guard) || seen.has(entry.guard)) {
      return [];
    }

    seen.add(entry.guard);

    return [
      {
        code: 'guard-never-handled' as const,
        severity: 'error' as const,
        subject: entry.guard,
        pieces: [],
        file: entry.file,
        line: entry.line,
        message: `guard ${entry.guard} (${entry.by}) has no responder: add @Handle(${entry.guard.split('.').at(-1)}) to a guard piece`,
      },
    ];
  });
}

export interface ConfiguredGuards {
  readonly name: string;
  readonly file: string;
  readonly guards: readonly string[];
}

function overlapsOf(app: StaticApp, guards: readonly string[]): string[] {
  const fieldsOf = (guard: string) => {
    const contract = app.contracts.find((c) => c.wireName === guard);
    const model = contract === undefined ? null : app.modelIn(contract);

    return { guard, model, fields: model?.fields ?? [] };
  };
  const outputs = guards.map(fieldsOf);

  return outputs.flatMap((left, at) =>
    outputs.slice(at + 1).flatMap((right) => {
      const shared = left.fields.filter((field) => right.fields.includes(field));
      if (shared.length === 0) {
        return [];
      }

      return [
        `${left.guard} (${modelName(left.model)}) and ${right.guard} (${modelName(right.model)}) both set ${shared.join(', ')}`,
      ];
    }),
  );
}

function modelName(model: StaticContract | null): string {
  return model?.className ?? '?';
}

function overlapProblems(
  app: StaticApp,
  all: readonly Served[],
  tokens: readonly ConfiguredGuards[],
): RouteProblem[] {
  const candidates = [
    ...tokens.map((t) => ({
      guards: t.guards,
      file: t.file,
      line: 1,
      pieces: [] as string[],
      where: `${t.name} defaults`,
    })),
    ...all.map((s) => ({
      guards: s.serve.guards,
      file: s.piece.file,
      line: s.serve.line,
      pieces: [s.piece.id],
      where: `route ${s.serve.key}`,
    })),
  ];
  const seen = new Set<string>();

  return candidates.flatMap((candidate) =>
    overlapsOf(app, candidate.guards).flatMap((overlap) => {
      if (seen.has(overlap)) {
        return [];
      }

      seen.add(overlap);

      return [
        {
          code: 'guard-output-overlap' as const,
          severity: 'error' as const,
          subject: candidate.where,
          pieces: candidate.pieces,
          file: candidate.file,
          line: candidate.line,
          message: `${candidate.where}: ${overlap}; req.auth would merge them silently, rename one field`,
        },
      ];
    }),
  );
}

function guardRef(contract: StaticContract | null | undefined, fallback: string): GuardRef {
  return { id: contract?.wireName ?? fallback, label: contract?.className ?? fallback };
}

export function guardShape(app: StaticApp, wireName: string): GuardShape {
  const contract = app.contracts.find((c) => c.wireName === wireName);
  const refs = (identifiers: readonly string[]) =>
    identifiers.map((id) => guardRef(contract === undefined ? null : app.contractIn(contract.file, id), id));

  return {
    ...guardRef(contract, wireName),
    after: refs(contract?.guard?.after ?? []),
    optional: refs(contract?.guard?.optional ?? []),
    metaKeys: (contract?.guard?.meta ?? []).map((m) => m.key),
  };
}

function admissionProblem(
  served: Served,
  code: 'guard-order' | 'guard-meta-unknown',
  message: string,
): RouteProblem {
  return {
    code,
    severity: 'error',
    subject: served.serve.key,
    pieces: [served.piece.id],
    file: served.piece.file,
    line: served.serve.line,
    message,
  };
}

function hasOpenMeta(app: StaticApp, guards: readonly string[]): boolean {
  return guards.some((guard) => app.contracts.find((c) => c.wireName === guard)?.guard?.metaOpen === true);
}

function admissionProblems(app: StaticApp, all: readonly Served[]): RouteProblem[] {
  return all.flatMap((served) => {
    const { key, guards, skipped, meta } = served.serve;
    const shapes = guards.map((guard) => guardShape(app, guard));
    const order = guardOrderProblem(key, shapes, skipped);
    const unknown = hasOpenMeta(app, guards) ? undefined : metaKeyProblem(key, shapes, meta);

    return [
      ...(order === undefined ? [] : [admissionProblem(served, 'guard-order', order)]),
      ...(unknown === undefined ? [] : [admissionProblem(served, 'guard-meta-unknown', unknown)]),
    ];
  });
}

export function configuredGuards(app: StaticApp): ConfiguredGuards[] {
  return app.tokens
    .filter((token): token is StaticToken & { transport: 'http' } => token.transport === 'http')
    .map((token) => ({
      name: token.name,
      file: token.file,
      guards: token.guards.flatMap((identifier) => app.contractIn(token.file, identifier)?.wireName ?? []),
    }));
}

export function analyzeRoutes(app: StaticApp, pieces: readonly PieceInfo[]): RouteAnalysis {
  const all = servedOf(pieces);
  const bindings = all.map(bindingOf);
  const tokens = configuredGuards(app);

  return {
    routes: all.map(catalogRoute),
    problems: [
      ...bindingConflicts(bindings).map((c) => conflictProblem(all, 'binding-conflict', c)),
      ...routeShadows(bindings).map((c) => conflictProblem(all, 'route-shadowed', c)),
      ...familyProblems(all),
      ...guardProblems(all, tokens, pieces),
      ...overlapProblems(app, all, tokens),
      ...admissionProblems(app, all),
    ],
  };
}
