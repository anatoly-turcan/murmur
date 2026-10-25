import type {
  Bus,
  Clock,
  DeliveryPolicyInput,
  Envelope,
  PieceRuntime,
  PublishOptions,
  SchemaIssue,
} from 'murmur';

import type { AppDefinition } from './app.ts';
import type { PieceDefinition } from './loader/class-piece.ts';

export interface RuntimeOptions {
  root: string;
  app?: AppDefinition;
  env?: NodeJS.ProcessEnv;
  configFile?: string;
  mode?: 'dev' | 'prod';
  process?: string;
  policy?: DeliveryPolicyInput;
  signals?: boolean;
  tap?: (envelope: Envelope, options: PublishOptions | undefined) => void;
}

export interface LoadedPiece {
  name: string;
  title: string;
  summary: string | null;
  parent: string | null;
  depth: number;
  file: string;
  dir: string;
  definition: PieceDefinition;
  config: Readonly<Record<string, unknown>>;
  needs: string[];
  runtime: PieceRuntime;
}

export type BootPhase = 'load' | 'declaration' | 'config' | 'needs' | 'contracts' | 'construct' | 'subscribe';
export type BootErrorCode =
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

export interface BootError {
  phase: BootPhase;
  code?: BootErrorCode;
  message: string;
  piece?: string;
  file?: string;
  issues?: SchemaIssue[];
}

export type BootWarningCode =
  | 'subscribed-never-emitted'
  | 'emitted-never-subscribed'
  | 'requested-never-handled'
  | 'config-key-unused'
  | 'capability-unused'
  | 'missing-summary'
  | 'clock-overridable-prod';

export interface BootWarning {
  code: BootWarningCode;
  subject: string;
  pieces: string[];
  message: string;
}

export interface CatalogContract {
  name: string;
  hasReply: boolean;
  visibility: 'public' | 'internal';
  scope: string | null;
  file: string | null;
  emitters: string[];
  handlers: string[];
}

export interface CatalogCapability {
  name: string;
  kind: 'ingress' | 'handle';
  usedBy: string[];
}

export interface CatalogRoute {
  transport: string;
  key: string;
  piece: string;
  guards: string[];
}

export interface Catalog {
  contracts: CatalogContract[];
  capabilities: CatalogCapability[];
  routes?: CatalogRoute[];
}

export interface BootReportPiece {
  name: string;
  file: string;
  errors: BootError[];
  warnings: BootWarning[];
}

export interface BootReport {
  ok: boolean;
  pieces: BootReportPiece[];
  errors: BootError[];
  warnings: BootWarning[];
  catalog: Catalog;
}

export interface Runtime extends AsyncDisposable {
  readonly bus: Bus;
  readonly clock: Clock;
  readonly pieces: readonly LoadedPiece[];
  readonly capabilities: ReadonlyMap<string, unknown>;
  readonly report: BootReport;
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
}
