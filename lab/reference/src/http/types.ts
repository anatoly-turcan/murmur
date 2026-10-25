import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { Role, UserRow } from '../domain/rows.ts';
import type { Logger } from '../log.ts';
import type { QuerySpec, QueryValues } from './query.ts';
import type { Id } from '../ids/uuid.ts';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type Params = Record<string, Id>;

export type ScopeResolver = (db: DatabaseSync, params: Params) => Id | null;

export interface Actor {
  user: UserRow;
  keyId: Id;
}

export interface Input {
  query: QueryValues;
  body: Record<string, unknown>;
  ifMatch: number | null;
}

export interface Page {
  limit: number;
  after: unknown[] | null;
}

export interface PageBody<T> {
  data: T[];
  next_cursor: string | null;
}

export interface Ctx {
  db: DatabaseSync;
  config: Config;
  log: Logger;
  now: number;
  ip: string;
  actor: Actor | null;
  params: Params;
  scopeWorkspaceId: Id | null;
  scopeRole: Role | null;
  header(name: string): string | undefined;
  me(): UserRow;
  input(): Input;
  page(): Page;
  pageOf<R, T = R>(rows: R[], keyOf: (row: R) => unknown[], map?: (row: R) => T): PageBody<T>;
}

export interface Result {
  status: number;
  body?: unknown;
  etag?: number;
  headers?: Record<string, string>;
  stream?: { contentType: string; chunks: Iterable<string> };
}

export interface Route {
  method: Method;
  path: string;
  auth?: 'required' | 'none';
  rateLimit?: boolean;
  scope?: ScopeResolver;
  body?: 'json' | 'none';
  idempotent?: boolean;
  idempotencyScope?: 'user' | 'ip';
  ifMatch?: boolean;
  list?: boolean;
  query?: QuerySpec;
  handle(ctx: Ctx): Result | Promise<Result>;
}
