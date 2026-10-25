import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { idRefs } from '../../ids/json-refs.ts';
import { recordMigration, type LegacyKind } from '../../ids/legacy.ts';
import { createIdGenerator, type Id } from '../../ids/uuid.ts';
import { all, one, run, statement } from '../sql.ts';

interface Source {
  kind: LegacyKind;
  table: string;
  created: string;
}

const SOURCES: readonly Source[] = [
  { kind: 'user', table: 'v1_users', created: 'created_at' },
  { kind: 'api_key', table: 'v1_api_keys', created: 'created_at' },
  { kind: 'organization', table: 'v1_organizations', created: 'created_at' },
  { kind: 'workspace', table: 'v1_workspaces', created: 'created_at' },
  { kind: 'project', table: 'v1_projects', created: 'created_at' },
  { kind: 'task', table: 'v1_tasks', created: 'created_at' },
  { kind: 'comment', table: 'v1_comments', created: 'created_at' },
  { kind: 'activity_event', table: 'v1_activity_events', created: 'occurred_at' },
  { kind: 'org_event', table: 'v1_org_events', created: 'occurred_at' },
  { kind: 'webhook', table: 'v1_webhook_endpoints', created: 'created_at' },
  { kind: 'delivery', table: 'v1_webhook_deliveries', created: 'created_at' },
  { kind: 'email', table: 'v1_outbox_emails', created: 'sent_at' },
];

const ACTIVITY_TARGET_KINDS: Record<string, LegacyKind> = {
  workspace: 'workspace',
  member: 'user',
  project: 'project',
  task: 'task',
  comment: 'comment',
  webhook: 'webhook',
  organization: 'organization',
  org_member: 'user',
};

const DROP_ORDER = [
  'v1_webhook_attempts',
  'v1_webhook_deliveries',
  'v1_webhook_endpoints',
  'v1_activity_events',
  'v1_comments',
  'v1_reminder_runs',
  'v1_tasks',
  'v1_projects',
  'v1_memberships',
  'v1_digest_runs',
  'v1_outbox_emails',
  'v1_org_events',
  'v1_org_memberships',
  'v1_workspaces',
  'v1_organizations',
  'v1_api_keys',
  'v1_users',
];

class IdMap {
  private readonly generator = createIdGenerator();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  mint(kind: LegacyKind, legacyId: number, ms: number): Id {
    const uuid = this.generator.next(ms);
    run(this.db, 'INSERT INTO legacy_ids (kind, legacy_id, uuid) VALUES (?, ?, ?)', kind, legacyId, uuid);

    return uuid;
  }

  find(kind: LegacyKind, legacyId: number): Id | undefined {
    return one<{ uuid: Id }>(this.db, 'SELECT uuid FROM legacy_ids WHERE kind = ? AND legacy_id = ?', kind, legacyId)?.uuid;
  }

  ensure(kind: LegacyKind, legacyId: number, ms: number): Id {
    return this.find(kind, legacyId) ?? this.mint(kind, legacyId, ms);
  }
}

function mapSource(db: DatabaseSync, ids: IdMap, s: Source): void {
  const rows = statement(db, `SELECT id, ${s.created} AS ms FROM ${s.table} ORDER BY ${s.created}, id`).iterate() as Iterable<{ id: number; ms: number }>;
  for (const row of [...rows]) ids.mint(s.kind, row.id, row.ms);
}

function mapOrphanTargets(db: DatabaseSync, ids: IdMap, table: string): void {
  const rows = all<{ target_type: string; target_id: number; ms: number }>(
    db,
    `SELECT target_type, target_id, min(occurred_at) AS ms FROM ${table} GROUP BY target_type, target_id ORDER BY ms, target_id`,
  );
  for (const r of rows) ids.ensure(ACTIVITY_TARGET_KINDS[r.target_type], r.target_id, r.ms);
}

function u(kind: LegacyKind, column: string): string {
  return `(SELECT uuid FROM legacy_ids WHERE kind = '${kind}' AND legacy_id = ${column})`;
}

function target(column: string): string {
  const cases = Object.entries(ACTIVITY_TARGET_KINDS).map(([type, kind]) => `WHEN '${type}' THEN ${u(kind, column)}`);

  return `CASE target_type ${cases.join(' ')} END`;
}

const COPIES: readonly string[] = [
  `INSERT INTO users (id, email, email_key, name, timezone, digest_enabled, created_at, updated_at, deactivated_at)
   SELECT ${u('user', 'id')}, email, email_key, name, timezone, digest_enabled, created_at, updated_at, deactivated_at FROM v1_users`,
  `INSERT INTO api_keys (id, user_id, name, prefix, secret_hash, created_at, last_used_at, revoked_at)
   SELECT ${u('api_key', 'id')}, ${u('user', 'user_id')}, name, prefix, secret_hash, created_at, last_used_at, revoked_at FROM v1_api_keys`,
  `INSERT INTO organizations (id, name, slug, slug_key, plan, owner_id, version, created_at, updated_at, deleted_at)
   SELECT ${u('organization', 'id')}, name, slug, slug_key, plan, ${u('user', 'owner_id')}, version, created_at, updated_at, deleted_at
     FROM v1_organizations`,
  `INSERT INTO org_memberships (organization_id, user_id, role, joined_at)
   SELECT ${u('organization', 'organization_id')}, ${u('user', 'user_id')}, role, joined_at FROM v1_org_memberships`,
  `INSERT INTO org_events (id, organization_id, type, actor_id, target_type, target_id, changes, occurred_at)
   SELECT ${u('org_event', 'id')}, ${u('organization', 'organization_id')}, type, ${u('user', 'actor_id')}, target_type,
          ${target('target_id')}, changes, occurred_at FROM v1_org_events`,
  `INSERT INTO workspaces (id, name, slug, slug_key, owner_id, organization_id, version, created_at, updated_at, deleted_at)
   SELECT ${u('workspace', 'id')}, name, slug, slug_key, ${u('user', 'owner_id')}, ${u('organization', 'organization_id')}, version,
          created_at, updated_at, deleted_at FROM v1_workspaces`,
  `INSERT INTO memberships (workspace_id, user_id, role, joined_at)
   SELECT ${u('workspace', 'workspace_id')}, ${u('user', 'user_id')}, role, joined_at FROM v1_memberships`,
  `INSERT INTO projects (id, workspace_id, name, slug, slug_key, description, creator_id, version, created_at, updated_at, deleted_at)
   SELECT ${u('project', 'id')}, ${u('workspace', 'workspace_id')}, name, slug, slug_key, description, ${u('user', 'creator_id')}, version,
          created_at, updated_at, deleted_at FROM v1_projects`,
  `INSERT INTO tasks (id, project_id, workspace_id, title, title_fold, description, description_fold, status, labels, labels_fold,
     assignee_id, creator_id, due_date, estimate_minutes, budget_currency, budget_minor, version, completed_at, created_at, updated_at, deleted_at)
   SELECT ${u('task', 'id')}, ${u('project', 'project_id')}, ${u('workspace', 'workspace_id')}, title, title_fold, description,
          description_fold, status, labels, labels_fold, ${u('user', 'assignee_id')}, ${u('user', 'creator_id')}, due_date,
          estimate_minutes, budget_currency, budget_minor, version, completed_at, created_at, updated_at, deleted_at FROM v1_tasks`,
  `INSERT INTO comments (id, task_id, workspace_id, author_id, body, body_fold, edited, version, created_at, updated_at, deleted_at)
   SELECT ${u('comment', 'id')}, ${u('task', 'task_id')}, ${u('workspace', 'workspace_id')}, ${u('user', 'author_id')}, body, body_fold,
          edited, version, created_at, updated_at, deleted_at FROM v1_comments`,
  `INSERT INTO activity_events (id, workspace_id, type, actor_id, target_type, target_id, changes, occurred_at)
   SELECT ${u('activity_event', 'id')}, ${u('workspace', 'workspace_id')}, type, ${u('user', 'actor_id')}, target_type,
          ${target('target_id')}, changes, occurred_at FROM v1_activity_events`,
  `INSERT INTO webhook_endpoints (id, workspace_id, organization_id, url, events, secret, active, created_at, updated_at)
   SELECT ${u('webhook', 'id')}, ${u('workspace', 'workspace_id')}, ${u('organization', 'organization_id')}, url, events, secret, active,
          created_at, updated_at FROM v1_webhook_endpoints`,
  `INSERT INTO webhook_deliveries (id, webhook_id, workspace_id, activity_event_id, event, payload, status, attempt_count,
     series_failures, next_attempt_at, job_id, created_at, completed_at)
   SELECT ${u('delivery', 'id')}, ${u('webhook', 'webhook_id')}, ${u('workspace', 'workspace_id')},
          CASE WHEN workspace_id IS NULL THEN ${u('org_event', 'activity_event_id')} ELSE ${u('activity_event', 'activity_event_id')} END,
          event, payload, status, attempt_count, series_failures, next_attempt_at, job_id, created_at, completed_at
     FROM v1_webhook_deliveries`,
  `INSERT INTO webhook_attempts (id, delivery_id, number, started_at, finished_at, outcome, status_code, error)
   SELECT id, ${u('delivery', 'delivery_id')}, number, started_at, finished_at, outcome, status_code, error FROM v1_webhook_attempts`,
  `INSERT INTO outbox_emails (id, to_email, template, subject, dedupe_key, data, sent_at, sink_written)
   SELECT ${u('email', 'id')}, to_email, template, subject, dedupe_key, data, sent_at, sink_written FROM v1_outbox_emails`,
  `INSERT INTO digest_runs (user_id, local_date, created_at) SELECT ${u('user', 'user_id')}, local_date, created_at FROM v1_digest_runs`,
  `INSERT INTO reminder_runs (task_id, due_date, created_at) SELECT ${u('task', 'task_id')}, due_date, created_at FROM v1_reminder_runs`,
];

function rewriteDocument(ids: IdMap, text: string, ms: number): string {
  const doc = JSON.parse(text) as unknown;
  for (const ref of idRefs(doc)) {
    if (typeof ref.value === 'number') ref.set(ids.ensure(ref.kind, ref.value, ms));
  }

  return JSON.stringify(doc);
}

function rewriteColumn(db: DatabaseSync, ids: IdMap, table: string, key: string, column: string, created: string): void {
  const rows = all<{ k: string | number; doc: string; ms: number }>(
    db,
    `SELECT ${key} AS k, ${column} AS doc, ${created} AS ms FROM ${table} WHERE ${column} NOT IN ('{}', '')`,
  );
  for (const r of rows) run(db, `UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`, rewriteDocument(ids, r.doc, r.ms), r.k);
}

function rewriteQueueKeys(db: DatabaseSync, ids: IdMap): void {
  const rows = all<{ id: number; queue_key: string; created_at: number }>(db, `SELECT id, queue_key, created_at FROM jobs WHERE queue_key LIKE 'webhook:%'`);
  for (const r of rows) {
    const legacy = Number(r.queue_key.slice('webhook:'.length));
    if (Number.isSafeInteger(legacy)) run(db, 'UPDATE jobs SET queue_key = ? WHERE id = ?', `webhook:${ids.ensure('webhook', legacy, r.created_at)}`, r.id);
  }
}

function rewriteIdempotencyScopes(db: DatabaseSync, ids: IdMap): void {
  const rows = all<{ scope: string; key: string; created_at: number }>(db, `SELECT scope, key, created_at FROM idempotency_keys WHERE scope LIKE 'user:%'`);
  for (const r of rows) {
    const legacy = Number(r.scope.slice('user:'.length));
    if (!Number.isSafeInteger(legacy)) continue;
    run(db, 'UPDATE idempotency_keys SET scope = ? WHERE scope = ? AND key = ?', `user:${ids.ensure('user', legacy, r.created_at)}`, r.scope, r.key);
  }
}

function rewriteDocuments(db: DatabaseSync, ids: IdMap): void {
  rewriteColumn(db, ids, 'activity_events', 'id', 'changes', 'occurred_at');
  rewriteColumn(db, ids, 'org_events', 'id', 'changes', 'occurred_at');
  rewriteColumn(db, ids, 'webhook_deliveries', 'id', 'payload', 'created_at');
  rewriteColumn(db, ids, 'outbox_emails', 'id', 'data', 'sent_at');
  rewriteColumn(db, ids, 'jobs', 'id', 'payload', 'created_at');
  rewriteQueueKeys(db, ids);
  rewriteIdempotencyScopes(db, ids);
}

// Rebuilds every table with UUIDv7 primary keys; the integer ids live on in legacy_ids for the 30-day read window.
export function migrateToUuids(db: DatabaseSync, now: number): void {
  db.exec('PRAGMA defer_foreign_keys = ON');
  const ids = new IdMap(db);
  for (const source of SOURCES) mapSource(db, ids, source);
  mapOrphanTargets(db, ids, 'v1_activity_events');
  mapOrphanTargets(db, ids, 'v1_org_events');
  for (const sql of COPIES) db.exec(sql);
  rewriteDocuments(db, ids);
  for (const table of DROP_ORDER) db.exec(`DROP TABLE ${table}`);
  recordMigration(db, now);
  run(db, 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', 'cursor_secret', randomBytes(32).toString('hex'));
}
