import type { DatabaseSync } from 'node:sqlite';
import { readOverride } from '../time/clock.ts';
import { backfillOrganizations002 } from './steps/organizations-002.ts';
import { migrateToUuids } from './steps/uuid-ids-003.ts';

export type PostStep = (db: DatabaseSync, now: number) => void;

export const POST_STEPS: Record<string, PostStep> = {
  '002-organizations.sql': backfillOrganizations002,
  '003-uuid-ids.sql': migrateToUuids,
};

export function migrationNow(db: DatabaseSync): number {
  return readOverride(db) ?? Date.now();
}
