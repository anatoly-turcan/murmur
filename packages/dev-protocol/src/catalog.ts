import type { DeliveryPolicy, SchemaIssue } from 'murmur';

export type ContractKind = 'query' | 'command' | 'event' | 'guard';

export type PieceKind = 'domain' | 'edge' | 'mixed';

export interface PieceConfigKey {
  key: string;
  type: string;
  source: 'env' | 'yaml' | 'default' | 'missing';
  env: string;
}

export interface PieceCounters {
  received: number;
  acked: number;
  failed: number;
  retried: number;
  deadLettered: number;
  inflight: number;
}

export interface PieceView {
  name: string;
  className: string | null;
  kind: PieceKind;
  title: string;
  summary: string | null;
  dir: string;
  parent: string | null;
  depth: number;
  children: string[];
  needs: string[];
  emits: string[];
  handles: string[];
  serves?: string[];
  requests?: string[];
  schedules?: string[];
  config: PieceConfigKey[];
  policy: DeliveryPolicy;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  counters: PieceCounters;
  lastDeliveryAt: string | null;
  p50Ms: number | null;
  p95Ms: number | null;
  hasContextMd: boolean;
  hasTests: boolean;
}

export interface ContractView {
  name: string;
  kind: ContractKind;
  className: string;
  hasReply: boolean;
  visibility: 'public' | 'internal';
  scope: string | null;
  file: string;
  emitters: string[];
  requesters?: string[];
  enqueuers?: string[];
  handlers: string[];
  schema: { payload: unknown; reply?: unknown };
}

export interface CapabilityView {
  name: string;
  kind: 'ingress' | 'handle';
  usedBy: string[];
}

export type CatalogWarningCode =
  | 'subscribed-never-emitted'
  | 'emitted-never-subscribed'
  | 'requested-never-handled'
  | 'missing-context-md'
  | 'missing-summary'
  | 'missing-tests'
  | 'orphan-contract'
  | 'binding-conflict'
  | 'route-shadowed'
  | 'route-family-split'
  | 'guard-never-handled'
  | 'guard-output-overlap'
  | 'guard-order'
  | 'guard-meta-unknown';

export interface CatalogWarning {
  code: CatalogWarningCode;
  subject: string;
  pieces: string[];
  message: string;
}

export interface CatalogRoute {
  transport: string;
  token: string;
  key: string;
  piece: string;
  method?: string;
  contract?: string;
  status?: number;
  guards: string[];
}

export interface TreeNode {
  id: string;
  kind: 'group' | 'piece';
  title: string;
  summary: string | null;
  children: TreeNode[];
}

export interface Catalog {
  contracts: ContractView[];
  pieces: PieceView[];
  tree: TreeNode[];
  capabilities: CapabilityView[];
  routes?: CatalogRoute[];
  warnings: CatalogWarning[];
}

export interface Snapshot {
  app: { name: string; root: string; transport: string; startedAt: string; bootDurationMs: number };
  pieces: PieceView[];
  contracts: ContractView[];
  capabilities: CapabilityView[];
  routes?: CatalogRoute[];
  warnings: CatalogWarning[];
  lastSeq: number;
}

export interface BootError {
  phase: 'load' | 'declaration' | 'config' | 'needs' | 'contracts' | 'construct' | 'subscribe' | 'start';
  code?:
    | 'config-env-collision'
    | 'piece-id'
    | 'contract-identity'
    | 'internal-contract-scope'
    | 'binding-conflict'
    | 'route-shadowed'
    | 'guard-output-overlap'
    | 'guard-order'
    | 'guard-meta-unknown'
    | 'guard-meta-invalid'
    | 'process-unknown'
    | 'process-invalid';
  message: string;
  piece?: string;
  file?: string;
  issues?: SchemaIssue[];
}

export interface BootWarning {
  code:
    | 'subscribed-never-emitted'
    | 'emitted-never-subscribed'
    | 'requested-never-handled'
    | 'config-key-unused'
    | 'capability-unused'
    | 'missing-summary'
    | 'clock-overridable-prod';
  subject: string;
  pieces: string[];
  message: string;
}

export interface BootReport {
  ok: boolean;
  pieces: Array<{ name: string; file: string; errors: BootError[]; warnings: BootWarning[] }>;
  errors: BootError[];
  warnings: BootWarning[];
  catalog?: unknown;
}

export function sendersOf(contract: Pick<ContractView, 'emitters' | 'requesters'>): string[] {
  return [...new Set([...contract.emitters, ...(contract.requesters ?? [])])];
}
