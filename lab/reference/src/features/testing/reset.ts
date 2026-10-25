import type { DatabaseSync } from 'node:sqlite';
import { immediate } from '../../db/tx.ts';
import { setOverride } from '../../time/clock.ts';

const DATA_TABLES = [
  'webhook_attempts',
  'webhook_deliveries',
  'webhook_endpoints',
  'activity_events',
  'org_events',
  'comments',
  'tasks',
  'projects',
  'memberships',
  'workspaces',
  'org_memberships',
  'organizations',
  'api_keys',
  'users',
  'jobs',
  'outbox_emails',
  'digest_runs',
  'reminder_runs',
  'idempotency_keys',
  'rate_limit_counters',
  'legacy_ids',
  'audit_entries',
  'audit_export_chunks',
  'audit_exports',
];

export function resetDatabase(db: DatabaseSync): void {
  immediate(db, () => {
    for (const table of DATA_TABLES) db.exec(`DELETE FROM ${table}`);
    setOverride(db, null);
  });
}
