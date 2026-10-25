import type { PiecePolicy } from 'murmur';

export type ContractKind = 'query' | 'command' | 'event' | 'guard';

export type PieceKind = 'domain' | 'edge' | 'mixed';

export interface FolderNode {
  readonly id: string;
  readonly dir: string;
  readonly kind: 'group' | 'piece';
  readonly pieceFile: string | null;
  readonly contextFile: string | null;
  readonly title: string;
  readonly summary: string | null;
  readonly frontmatterError: string | null;
  readonly hasFrontmatter: boolean;
  readonly files: readonly string[];
  readonly children: readonly string[];
  readonly parent: string | null;
  readonly depth: number;
}

export interface ContractFile {
  readonly file: string;
  readonly visibility: 'public' | 'internal';
  readonly scope: string | null;
}

export interface Repo {
  readonly root: string;
  readonly piecesDir: string;
  readonly folders: ReadonlyMap<string, FolderNode>;
  readonly contractFiles: readonly ContractFile[];
  readonly capabilityFiles: readonly string[];
}

export interface ConfigKeyInfo {
  readonly key: string;
  readonly type: string;
  readonly hasDefault: boolean;
}

export interface HandlerInfo {
  readonly contract: string;
  readonly hasReply: boolean;
  readonly exported: boolean;
  readonly every?: string;
}

export interface ServeInfo {
  readonly transport: string;
  readonly token: string;
  readonly key: string;
  readonly method: string | null;
  readonly contract: string | null;
  readonly status: number | null;
  readonly guards: readonly string[];
  readonly skipped: readonly string[];
  readonly meta: readonly string[];
  readonly metaText: string | null;
  readonly idempotent: { readonly scope: readonly string[]; readonly ttlMs: number | null } | null;
  readonly line: number;
}

export interface PieceInfo {
  readonly id: string;
  readonly file: string;
  readonly error: string | null;
  readonly hasPieceClass: boolean;
  readonly className?: string;
  readonly needFields?: readonly string[];
  readonly requests?: readonly string[];
  readonly jobs?: readonly string[];
  readonly serves?: readonly ServeInfo[];
  readonly unresolvedServes?: number;
  readonly handlers: readonly HandlerInfo[];
  readonly emits: readonly string[];
  readonly needs: readonly string[];
  readonly config: readonly ConfigKeyInfo[];
  readonly policy: PiecePolicy;
}

export interface ContractInfo {
  readonly name: string;
  readonly exportName: string;
  readonly file: string;
  readonly visibility: 'public' | 'internal';
  readonly scope: string | null;
  readonly hasReply: boolean;
  readonly schema: { readonly payload: unknown; readonly reply?: unknown } | null;
  readonly schemaError: string | null;
  readonly kind: ContractKind;
  readonly className: string;
  readonly runtimeName?: string;
}

export interface CapabilityInfo {
  readonly name: string;
  readonly kind: 'ingress' | 'handle';
  readonly origin: 'builtin' | 'app' | 'local';
  readonly file: string | null;
  readonly docs: string | null;
  readonly emits: readonly string[];
  readonly routes: number;
}

export interface Limits {
  readonly ctxLargeTokens: number;
  readonly ctxWarnTokens: number;
  readonly ctxFailTokens: number;
  readonly pieceLines: number;
  readonly handlers: number;
  readonly contextLines: number;
}

export interface FileError {
  readonly file: string;
  readonly message: string;
}

export interface DescribeError {
  readonly code: 'contract-identity' | 'internal-contract-scope' | 'not-a-piece';
  readonly message: string;
  readonly file: string;
}

export interface ProcessView {
  readonly name: string;
  readonly globs: readonly string[];
}

export interface RepoDescription {
  readonly pieces: readonly PieceInfo[];
  readonly contracts: readonly ContractInfo[];
  readonly capabilities: readonly CapabilityInfo[];
  readonly appLoaded: boolean;
  readonly appError: string | null;
  readonly processes: readonly ProcessView[] | null;
  readonly transport: 'memory' | 'other';
  readonly limits: Limits;
  readonly importErrors: readonly FileError[];
  readonly errors: readonly DescribeError[];
}

export interface TreeNode {
  readonly id: string;
  readonly kind: 'group' | 'piece';
  readonly title: string;
  readonly summary: string | null;
  readonly children: readonly TreeNode[];
}

export interface ConfigView {
  readonly key: string;
  readonly type: string;
  readonly source: 'env' | 'yaml' | 'default' | 'missing';
  readonly env: string;
}

export interface PieceView {
  readonly name: string;
  readonly className: string | null;
  readonly kind: PieceKind;
  readonly title: string;
  readonly summary: string | null;
  readonly dir: string;
  readonly parent: string | null;
  readonly depth: number;
  readonly children: readonly string[];
  readonly needs: readonly string[];
  readonly needFields: readonly string[];
  readonly emits: readonly string[];
  readonly handles: readonly string[];
  readonly serves: readonly string[];
  readonly requests: readonly string[];
  readonly schedules: readonly string[];
  readonly config: readonly ConfigView[];
  readonly policy: PiecePolicy;
  readonly hasContextMd: boolean;
  readonly hasTests: boolean;
}

export interface ContractView {
  readonly name: string;
  readonly kind: ContractKind;
  readonly className: string;
  readonly hasReply: boolean;
  readonly visibility: 'public' | 'internal';
  readonly scope: string | null;
  readonly file: string;
  readonly emitters: readonly string[];
  readonly requesters: readonly string[];
  readonly enqueuers: readonly string[];
  readonly handlers: readonly string[];
  readonly schema: { readonly payload: unknown; readonly reply?: unknown } | null;
}

export type CatalogWarningCode =
  | 'subscribed-never-emitted'
  | 'emitted-never-subscribed'
  | 'requested-never-handled'
  | 'missing-context-md'
  | 'missing-summary'
  | 'missing-tests'
  | 'orphan-contract'
  | 'route-family-split'
  | 'guard-never-handled';

export interface CatalogWarning {
  readonly code: CatalogWarningCode;
  readonly subject: string;
  readonly pieces: readonly string[];
  readonly message: string;
}

export type CatalogErrorCode =
  | 'piece-id'
  | 'contract-identity'
  | 'internal-contract-scope'
  | 'wire-name'
  | 'one-piece-per-folder'
  | 'binding-conflict'
  | 'route-shadowed'
  | 'guard-output-overlap'
  | 'guard-order'
  | 'guard-meta-unknown';

export interface CatalogError {
  readonly code: CatalogErrorCode;
  readonly message: string;
  readonly file: string;
  readonly subject?: string;
  readonly pieces?: readonly string[];
}

export interface CapabilityView {
  readonly name: string;
  readonly kind: 'ingress' | 'handle';
  readonly usedBy: readonly string[];
  readonly routes?: number;
}

export interface CatalogRoute {
  readonly transport: string;
  readonly token: string;
  readonly key: string;
  readonly piece: string;
  readonly method?: string;
  readonly contract?: string;
  readonly status?: number;
  readonly guards: readonly string[];
}

export interface Catalog {
  readonly contracts: readonly ContractView[];
  readonly pieces: readonly PieceView[];
  readonly tree: readonly TreeNode[];
  readonly capabilities: readonly CapabilityView[];
  readonly routes: readonly CatalogRoute[];
  readonly warnings: readonly CatalogWarning[];
  readonly errors: readonly CatalogError[];
}
