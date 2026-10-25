import type { DatabaseSync } from 'node:sqlite';
import type { Route } from '../http/types.ts';
import type { JobHandlers } from '../jobs/types.ts';
import type { Id } from '../ids/uuid.ts';

export type SchedulerCounter = 'digests_created' | 'reminders_created';

export interface SchedulerRule {
  counter?: SchedulerCounter;
  run(db: DatabaseSync, now: number, manual: boolean): number;
}

export interface SeedUser {
  email: string;
  api_key: string;
  workspace_ids: Id[];
}

export interface SeedResult {
  users: SeedUser[];
}

export interface Slice {
  name: string;
  routes: Route[];
  jobHandlers: JobHandlers;
  schedulerRules: SchedulerRule[];
  seed?: (db: DatabaseSync, now: number) => SeedResult;
}
