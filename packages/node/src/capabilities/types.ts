import type { CommandClass, InputOf, ModelClass } from 'murmur';

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Sqlite {
  run(sql: string, ...params: unknown[]): Promise<SqliteRunResult>;
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  rows<M extends ModelClass>(model: M, sql: string, ...params: unknown[]): Promise<InstanceType<M>[]>;
  row<M extends ModelClass>(model: M, sql: string, ...params: unknown[]): Promise<InstanceType<M> | null>;
  exec(sql: string): Promise<void>;
  insert(table: string, row: Readonly<Record<string, unknown>>): Promise<number | string>;
  transaction<T>(work: (tx: Sqlite) => Promise<T>): Promise<T>;
}

export type OnceResult<T> = { first: true; value: T } | { first: false };

export interface Kv {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, options?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  once<T>(id: string, effect: () => T | Promise<T>, options?: { ttlMs?: number }): Promise<OnceResult<T>>;
  incr(key: string, options: { windowMs: number }): Promise<{ count: number; resetAt: Temporal.Instant }>;
}

export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface EnqueueOptions {
  readonly runAt?: Temporal.Instant;
  readonly dedupeKey?: string;
  readonly groupKey?: string;
}

export interface JobCounts {
  readonly pending: number;
  readonly running: number;
  readonly dead: number;
}

export interface DrainResult {
  readonly ran: number;
  readonly failed: number;
  readonly dead: number;
}

export interface Jobs {
  enqueue<C extends CommandClass>(
    contract: C,
    input: InputOf<C>,
    options?: EnqueueOptions,
  ): Promise<{ enqueued: boolean }>;
  drain(): Promise<DrainResult>;
  counts(): Promise<JobCounts>;
}
