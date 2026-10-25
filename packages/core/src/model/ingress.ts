import type { Delivery } from './delivery.ts';
import type { JobSysName, SysPayloads } from './internal.ts';
import type { JobInvokeInit, JobTarget } from './jobs.ts';
import type { ServeEntry } from './metadata.ts';

export interface InvokeInit {
  readonly transport: string;
  readonly binding: string;
  readonly traceId?: string | undefined;
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly id?: string | undefined;
  readonly attempt?: number | undefined;
}

export type EntryFn<R> = (delivery: Delivery) => R | Promise<R>;

export interface IngressTarget {
  readonly piece: string;
  readonly serve: ServeEntry;
  instance(): object;
}

export interface IngressPort {
  targets(transport: string): readonly IngressTarget[];
  invoke<R>(piece: string, init: InvokeInit, fn: EntryFn<R>): Promise<Awaited<R>>;
  readonly ready: Promise<void>;
  jobTargets(): readonly JobTarget[];
  invokeLocal(contract: string, input: unknown, init: JobInvokeInit): Promise<unknown>;
  report<K extends JobSysName>(name: K, payload: SysPayloads[K]): void;
}
