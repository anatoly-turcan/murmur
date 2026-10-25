import { basename } from 'node:path';

import type * as Dev from '@murmur/dev-protocol';
import type { DeliveryPolicy, PiecePolicy } from 'murmur';

import { ROUTE_ERROR_CODES } from '../analysis/routes.ts';
import type * as Static from '../analysis/types.ts';
import type { BootInfo } from './ipc.ts';
import { percentile, type LiveState, type PieceLive } from './live.ts';

const DEFAULT_POLICY: DeliveryPolicy = {
  concurrency: 8,
  timeoutMs: 30_000,
  retry: { maxAttempts: 5, baseMs: 200, maxMs: 30_000, jitter: 0.5 },
  requestTimeoutMs: 10_000,
};

export const EMPTY_CATALOG: Static.Catalog = {
  contracts: [],
  pieces: [],
  tree: [],
  capabilities: [],
  routes: [],
  warnings: [],
  errors: [],
};

const IDLE: PieceLive = {
  status: 'stopped',
  policy: null,
  counters: { received: 0, acked: 0, failed: 0, retried: 0, deadLettered: 0, inflight: 0 },
  lastDeliveryAt: null,
  samples: [],
};

export interface SnapshotInput {
  readonly root: string;
  readonly catalog: Static.Catalog;
  readonly live: LiveState;
  readonly lastSeq: number;
}

function declaredPolicy(policy: PiecePolicy): DeliveryPolicy {
  return { ...DEFAULT_POLICY, ...policy, retry: { ...DEFAULT_POLICY.retry, ...policy.retry } };
}

export function toTree(nodes: readonly Static.TreeNode[]): Dev.TreeNode[] {
  return nodes.map((node) => ({ ...node, children: toTree(node.children) }));
}

export function toPieceView(view: Static.PieceView, live: LiveState): Dev.PieceView {
  const state = live.piece(view.name) ?? IDLE;

  return {
    ...view,
    children: [...view.children],
    needs: [...view.needs],
    emits: [...view.emits],
    handles: [...view.handles],
    serves: [...view.serves],
    requests: [...view.requests],
    schedules: [...view.schedules],
    config: view.config.map((key) => ({ ...key })),
    policy: state.policy ?? declaredPolicy(view.policy),
    status: state.status,
    counters: { ...state.counters },
    lastDeliveryAt: state.lastDeliveryAt,
    p50Ms: percentile(state.samples, 50),
    p95Ms: percentile(state.samples, 95),
  };
}

function toContractView(view: Static.ContractView): Dev.ContractView {
  return {
    ...view,
    emitters: [...view.emitters],
    requesters: [...view.requesters],
    enqueuers: [...view.enqueuers],
    handlers: [...view.handlers],
    schema: view.schema === null ? { payload: null } : { ...view.schema },
  };
}

function isRouteError(
  error: Static.CatalogError,
): error is Static.CatalogError & { code: Dev.CatalogWarningCode } {
  return ROUTE_ERROR_CODES.has(error.code);
}

function routeWarning(error: Static.CatalogError & { code: Dev.CatalogWarningCode }): Dev.CatalogWarning {
  return {
    code: error.code,
    subject: error.subject ?? error.file,
    pieces: [...(error.pieces ?? [])],
    message: error.message,
  };
}

function toWarnings(catalog: Static.Catalog): Dev.CatalogWarning[] {
  const routeErrors = catalog.errors.filter(isRouteError).map(routeWarning);

  return [
    ...catalog.warnings.map((warning) => ({ ...warning, pieces: [...warning.pieces] })),
    ...routeErrors,
  ];
}

function toRoute(route: Static.CatalogRoute): Dev.CatalogRoute {
  return { ...route, guards: [...route.guards] };
}

type RoutedCatalog = Dev.Catalog & Required<Pick<Dev.Catalog, 'routes'>>;

export function toCatalog(catalog: Static.Catalog, live: LiveState): RoutedCatalog {
  return {
    contracts: catalog.contracts.map(toContractView),
    pieces: catalog.pieces.map((view) => toPieceView(view, live)),
    tree: toTree(catalog.tree),
    capabilities: catalog.capabilities.map((cap) => ({ ...cap, usedBy: [...cap.usedBy] })),
    routes: catalog.routes.map(toRoute),
    warnings: toWarnings(catalog),
  };
}

function appOf(root: string, info: BootInfo | null): Dev.Snapshot['app'] {
  return {
    name: info?.app ?? basename(root),
    root,
    transport: info?.transport ?? 'unknown',
    startedAt: info?.startedAt ?? '',
    bootDurationMs: info?.bootDurationMs ?? 0,
  };
}

export function toSnapshot(input: SnapshotInput): Dev.Snapshot {
  const { contracts, pieces, capabilities, routes, warnings } = toCatalog(input.catalog, input.live);

  return {
    app: appOf(input.root, input.live.info()),
    pieces,
    contracts,
    capabilities,
    routes,
    warnings,
    lastSeq: input.lastSeq,
  };
}
