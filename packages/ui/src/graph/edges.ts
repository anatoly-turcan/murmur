import {
  sendersOf,
  type CapabilityView,
  type CatalogRoute,
  type CatalogWarning,
  type ContractView,
  type PieceKind,
  type PieceView,
  type TreeNode,
} from '@murmur/dev-protocol';

import { displayName, kindMark } from '../components/contract-kind.ts';
import { ancestors, buildTree, compareIds, subtreePieces } from '../store/tree.ts';

export const DEAD_LETTER = '$dead-letter';

export type NodeKind = 'piece' | 'group' | 'ingress' | 'dlq' | 'ghost';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  members: string[];
  childCount: number;
  group: string | null;
  pieceKind?: PieceKind;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  contract: string;
  internal: boolean;
  warning: boolean;
  guard?: boolean;
  badge?: string;
  label?: string;
}

export interface GraphInput {
  pieces: PieceView[];
  contracts: ContractView[];
  capabilities: CapabilityView[];
  routes?: CatalogRoute[];
  warnings: CatalogWarning[];
  expanded: ReadonlySet<string>;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface Scope {
  pieceIds: Set<string>;
  groupIds: Set<string>;
  expanded: ReadonlySet<string>;
}

function scopeOf(input: GraphInput): Scope {
  const pieceIds = new Set(input.pieces.map((p) => p.name));
  const groupIds = new Set(input.pieces.flatMap((p) => ancestors(p.name)));

  return { pieceIds, groupIds, expanded: input.expanded };
}

export function representative(scope: Scope, piece: string): string | null {
  if (!scope.pieceIds.has(piece)) {
    return null;
  }

  for (const id of [...ancestors(piece), piece]) {
    if (scope.groupIds.has(id) && !scope.expanded.has(id)) {
      return id;
    }
  }

  return piece;
}

function nearestExpanded(scope: Scope, id: string): string | null {
  return ancestors(id).findLast((a) => scope.expanded.has(a)) ?? null;
}

export function servesRoutes(kind: PieceKind | undefined): boolean {
  return kind === 'edge' || kind === 'mixed';
}

function unitKind(
  members: string[],
  kinds: ReadonlyMap<string, PieceKind | undefined>,
): PieceKind | undefined {
  const known = members.flatMap((member) => kinds.get(member) ?? []);
  if (known.length === 0) {
    return undefined;
  }

  if (known.every((kind) => kind === 'edge')) {
    return 'edge';
  }

  if (known.some(servesRoutes)) {
    return 'mixed';
  }

  return 'domain';
}

interface UnitContext {
  tree: TreeNode[];
  scope: Scope;
  titles: ReadonlyMap<string, string>;
  kinds: ReadonlyMap<string, PieceKind | undefined>;
}

function unitNode(unit: UnitContext, id: string): GraphNode {
  const { scope } = unit;
  const collapsed = scope.groupIds.has(id) && !scope.expanded.has(id);
  const members = collapsed ? subtreePieces(unit.tree, id) : [id];
  const pieceKind = unitKind(members, unit.kinds);

  return {
    id,
    kind: collapsed ? 'group' : 'piece',
    label: unit.titles.get(id) ?? id.slice(id.lastIndexOf('/') + 1),
    members,
    childCount: collapsed ? members.filter((m) => m !== id).length : 0,
    group: nearestExpanded(scope, id),
    ...(pieceKind === undefined ? {} : { pieceKind }),
  };
}

function fixedNode(id: string, kind: NodeKind, label: string): GraphNode {
  return { id, kind, label, members: [], childCount: 0, group: null };
}

type EdgeExtras = Partial<Pick<GraphEdge, 'internal' | 'warning' | 'guard' | 'badge' | 'label'>>;

function edge(from: string, to: string, contract: string, extras: EdgeExtras = {}): GraphEdge {
  return { id: `${from}|${contract}|${to}`, from, to, contract, internal: false, warning: false, ...extras };
}

function contractExtras(contract: ContractView): EdgeExtras {
  return {
    internal: contract.visibility === 'internal',
    badge: kindMark(contract).letter,
    label: displayName(contract),
  };
}

function byId<T extends { id: string }>(items: Iterable<T>): T[] {
  return [...new Map([...items].map((item) => [item.id, item])).values()].toSorted(compareIds);
}

function ingressEdges(input: GraphInput, scope: Scope): GraphEdge[] {
  const used = input.capabilities
    .filter((c) => c.kind === 'ingress')
    .flatMap((c) => c.usedBy.map((piece) => ({ token: c.name, piece })));
  const served = (input.routes ?? []).map((route) => ({ token: route.token, piece: route.piece }));

  return [...used, ...served].flatMap(({ token, piece }) => {
    const to = representative(scope, piece);

    return to === null ? [] : [edge(`ingress:${token}`, to, token)];
  });
}

function guardEdges(input: GraphInput, scope: Scope): GraphEdge[] {
  const contracts = new Map(input.contracts.map((c) => [c.name, c]));

  return (input.routes ?? []).flatMap((route) =>
    route.guards.flatMap((wire) => {
      const guard = contracts.get(wire);
      const handlers = guard?.handlers.flatMap((h) => representative(scope, h) ?? []) ?? [];
      const extras: EdgeExtras =
        guard === undefined ? { guard: true } : { ...contractExtras(guard), guard: true };

      return handlers.map((to) => edge(`ingress:${route.token}`, to, wire, extras));
    }),
  );
}

function ingressTokens(input: GraphInput): string[] {
  const capabilities = input.capabilities.filter((c) => c.kind === 'ingress').map((c) => c.name);

  return [...new Set([...capabilities, ...(input.routes ?? []).map((route) => route.token)])];
}

function contractEdges(input: GraphInput, scope: Scope): GraphEdge[] {
  return input.contracts.flatMap((c) =>
    sendersOf(c).flatMap((e) =>
      c.handlers.flatMap((h) => {
        const from = representative(scope, e);
        const to = representative(scope, h);

        return from && to && from !== to ? [edge(from, to, c.name, contractExtras(c))] : [];
      }),
    ),
  );
}

const TO_GHOST = new Set(['emitted-never-subscribed', 'requested-never-handled']);
const FROM_GHOST = new Set(['subscribed-never-emitted']);

function warningEdges(input: GraphInput, scope: Scope): GraphEdge[] {
  return input.warnings.flatMap((w) => {
    const ghost = `ghost:${w.subject}`;
    const reps = w.pieces.flatMap((p) => representative(scope, p) ?? []);

    if (TO_GHOST.has(w.code)) {
      return reps.map((rep) => edge(rep, ghost, w.subject, { warning: true }));
    }

    if (FROM_GHOST.has(w.code)) {
      return reps.map((rep) => edge(ghost, rep, w.subject, { warning: true }));
    }

    return [];
  });
}

export function buildGraph(input: GraphInput): GraphModel {
  const scope = scopeOf(input);
  const unit: UnitContext = {
    tree: buildTree(input.pieces),
    scope,
    titles: new Map(input.pieces.map((p) => [p.name, p.title])),
    kinds: new Map(input.pieces.map((p) => [p.name, p.kind])),
  };
  const units = byId(input.pieces.flatMap((p) => representative(scope, p.name) ?? []).map((id) => ({ id })));
  const ingress = ingressTokens(input).map((token) => fixedNode(`ingress:${token}`, 'ingress', token));
  const warnings = byId(warningEdges(input, scope));
  const ghosts = byId(
    warnings
      .flatMap((e) => [e.from, e.to])
      .filter((id) => id.startsWith('ghost:'))
      .map((id) => ({ id })),
  );

  return {
    nodes: [
      ...byId(ingress),
      ...units.map((u) => unitNode(unit, u.id)),
      ...ghosts.map((g) => fixedNode(g.id, 'ghost', g.id.slice('ghost:'.length))),
      fixedNode(DEAD_LETTER, 'dlq', 'dead letters'),
    ],
    edges: [
      ...byId(ingressEdges(input, scope)),
      ...byId(guardEdges(input, scope)),
      ...byId(contractEdges(input, scope)),
      ...warnings,
    ],
  };
}
