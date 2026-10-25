import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { Logger } from '../log.ts';

export type JobType = 'webhook_delivery' | 'email' | 'digest' | 'reminder' | 'maintenance' | 'audit_retention' | 'audit_export';
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'dead';

export const JOB_TYPES: readonly JobType[] = ['webhook_delivery', 'email', 'digest', 'reminder', 'maintenance', 'audit_retention', 'audit_export'];
export const JOB_STATUSES: readonly JobStatus[] = ['pending', 'running', 'succeeded', 'dead'];

export interface JobRow {
  id: number;
  type: JobType;
  status: JobStatus;
  payload: string;
  run_at: number;
  attempt_count: number;
  last_error: string | null;
  queue_key: string | null;
  queue_pos: number | null;
  locked_by: string | null;
  locked_at: number | null;
  created_at: number;
  updated_at: number;
}

export type JobResult =
  | { status: 'succeeded' }
  | { status: 'retry'; runAt: number; error: string }
  | { status: 'dead'; error: string };

export interface JobOutcome {
  result: JobResult;
  apply?: () => void;
  afterCommit?: () => void;
}

export interface JobContext {
  db: DatabaseSync;
  config: Config;
  log: Logger;
  workerId: string;
  now(): number;
  begin<T>(fn: () => T): T;
}

export interface JobHandler {
  run(job: JobRow, ctx: JobContext): Promise<JobOutcome>;
  onInterrupted?(db: DatabaseSync, job: JobRow, now: number): JobOutcome;
}

export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export function jobPayload<T>(job: JobRow): T {
  return JSON.parse(job.payload) as T;
}

export const succeeded = (extra: Omit<JobOutcome, 'result'> = {}): JobOutcome => ({ result: { status: 'succeeded' }, ...extra });
