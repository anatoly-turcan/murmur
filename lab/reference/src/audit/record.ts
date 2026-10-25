import type { DatabaseSync } from 'node:sqlite';
import { run } from '../db/sql.ts';
import { immediate } from '../db/tx.ts';
import { newId } from '../ids/uuid.ts';
import { currentAudit } from './context.ts';
import { diffOf, stableJson } from './diff.ts';
import { snapshot, type AuditRef, type Snapshot, type View } from './snapshots.ts';

export const AUDIT_ACTIONS = ['create', 'update', 'delete', 'restore', 'transfer', 'revoke', 'claim', 'deliver', 'send'] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

function view(now: number): View {
  return { now, timezone: currentAudit().timezone };
}

function bodyJson(s: Snapshot | null): string | null {
  return s ? stableJson(s.body) : null;
}

function writeEntry(db: DatabaseSync, now: number, ref: AuditRef, action: AuditAction, before: Snapshot | null, after: Snapshot | null): void {
  const scope = after ?? before;
  if (!scope) return;
  const ctx = currentAudit();
  run(
    db,
    `INSERT INTO audit_entries (id, occurred_at, actor_type, actor_id, actor_name, api_key_id, ip, request_id, organization_id, workspace_id,
       resource_type, resource_id, action, before, after, diff)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(now),
    now,
    ctx.actor.type,
    ctx.actor.id,
    ctx.actor.name,
    ctx.apiKeyId,
    ctx.ip,
    ctx.requestId,
    scope.organizationId,
    scope.workspaceId,
    ref.type,
    ref.id,
    action,
    bodyJson(before),
    bodyJson(after),
    stableJson(diffOf(ref.type, before?.body ?? null, after?.body ?? null)),
  );
}

export function auditCreated(db: DatabaseSync, now: number, ref: AuditRef, action: AuditAction = 'create'): void {
  immediate(db, () => writeEntry(db, now, ref, action, null, snapshot(db, ref, view(now))));
}

export function audited<T>(db: DatabaseSync, now: number, ref: AuditRef, action: AuditAction, mutate: () => T): T {
  return immediate(db, () => {
    const before = snapshot(db, ref, view(now));
    const result = mutate();
    writeEntry(db, now, ref, action, before, snapshot(db, ref, view(now)));

    return result;
  });
}
