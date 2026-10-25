import type { DatabaseSync } from 'node:sqlite';
import { one } from '../db/sql.ts';
import type { ApiKeyRow, CommentRow, DeliveryRow, OrganizationRow, ProjectRow, TaskRow, UserRow, WebhookRow, WorkspaceRow } from '../domain/rows.ts';
import { serializeApiKey } from '../features/api-keys/serialize.ts';
import { serializeExport, type ExportRow } from '../features/audit/export-row.ts';
import { serializeComment } from '../features/comments/serialize.ts';
import { loadMember, serializeMember } from '../features/members/serialize.ts';
import { loadOrgMember, serializeOrganization, serializeOrgMember } from '../features/organizations/serialize.ts';
import { serializeProject } from '../features/projects/serialize.ts';
import { serializeTask } from '../features/tasks/serialize.ts';
import { serializeUser } from '../features/users/serialize.ts';
import { serializeDeliveries, serializeWebhook } from '../features/webhooks/serialize.ts';
import { serializeWorkspace } from '../features/workspaces/serialize.ts';
import { emailRecord, type OutboxRow } from '../jobs/email-job.ts';
import { isoOrNull } from '../time/format.ts';
import type { Id } from '../ids/uuid.ts';

export const RESOURCE_TYPES = [
  'user',
  'api_key',
  'organization',
  'org_member',
  'workspace',
  'member',
  'project',
  'task',
  'comment',
  'webhook',
  'delivery',
  'email',
  'audit_export',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export interface Scope {
  workspaceId: Id | null;
  organizationId: Id | null;
}

export interface AuditRef {
  type: ResourceType;
  id: Id;
  parentId?: Id;
  scope?: Scope;
}

export interface Snapshot extends Scope {
  body: Record<string, unknown>;
}

export interface View {
  now: number;
  timezone: string;
}

type Loader = (db: DatabaseSync, ref: AuditRef, view: View) => Snapshot | null;

export const REDACTED = '[redacted]';

function row<T>(db: DatabaseSync, table: string, id: Id): T | undefined {
  return one<T>(db, `SELECT * FROM ${table} WHERE id = ?`, id);
}

export function organizationOf(db: DatabaseSync, workspaceId: Id | null): Id | null {
  if (workspaceId === null) return null;

  return one<{ organization_id: Id }>(db, 'SELECT organization_id FROM workspaces WHERE id = ?', workspaceId)?.organization_id ?? null;
}

function inWorkspace(db: DatabaseSync, workspaceId: Id, body: Record<string, unknown>): Snapshot {
  return { body, workspaceId, organizationId: organizationOf(db, workspaceId) };
}

function unscoped(body: Record<string, unknown>): Snapshot {
  return { body, workspaceId: null, organizationId: null };
}

function webhookScope(db: DatabaseSync, hook: Pick<WebhookRow, 'workspace_id' | 'organization_id'> | undefined): Scope {
  if (!hook) return { workspaceId: null, organizationId: null };

  return { workspaceId: hook.workspace_id, organizationId: hook.organization_id ?? organizationOf(db, hook.workspace_id) };
}

function workspaceBody(ws: WorkspaceRow): Record<string, unknown> {
  const { my_role: _viewerDependent, ...body } = serializeWorkspace(ws, null);

  return body;
}

const LOADERS: Record<ResourceType, Loader> = {
  user(db, ref) {
    const user = row<UserRow>(db, 'users', ref.id);

    return user ? unscoped({ ...serializeUser(user), deactivated_at: isoOrNull(user.deactivated_at) }) : null;
  },
  api_key(db, ref) {
    const key = row<ApiKeyRow>(db, 'api_keys', ref.id);

    return key ? unscoped({ ...serializeApiKey(key), user_id: key.user_id }) : null;
  },
  organization(db, ref) {
    const org = row<OrganizationRow>(db, 'organizations', ref.id);

    return org ? { body: serializeOrganization(org), workspaceId: null, organizationId: org.id } : null;
  },
  org_member(db, ref) {
    const member = loadOrgMember(db, ref.parentId!, ref.id);

    return member ? { body: { organization_id: member.organization_id, ...serializeOrgMember(member) }, workspaceId: null, organizationId: member.organization_id } : null;
  },
  workspace(db, ref) {
    const ws = row<WorkspaceRow>(db, 'workspaces', ref.id);

    return ws ? { body: workspaceBody(ws), workspaceId: ws.id, organizationId: ws.organization_id } : null;
  },
  member(db, ref) {
    const member = loadMember(db, ref.parentId!, ref.id);

    return member ? inWorkspace(db, member.workspace_id, { workspace_id: member.workspace_id, ...serializeMember(member) }) : null;
  },
  project(db, ref) {
    const project = row<ProjectRow>(db, 'projects', ref.id);

    return project ? inWorkspace(db, project.workspace_id, serializeProject(project)) : null;
  },
  task(db, ref, view) {
    const task = row<TaskRow>(db, 'tasks', ref.id);

    return task ? inWorkspace(db, task.workspace_id, serializeTask(task, view.timezone, view.now)) : null;
  },
  comment(db, ref) {
    const comment = row<CommentRow>(db, 'comments', ref.id);

    return comment ? inWorkspace(db, comment.workspace_id, serializeComment(db, comment)) : null;
  },
  webhook(db, ref) {
    const hook = row<WebhookRow>(db, 'webhook_endpoints', ref.id);

    return hook ? { body: { ...serializeWebhook(hook), secret: REDACTED }, ...webhookScope(db, hook) } : null;
  },
  delivery(db, ref) {
    const delivery = row<DeliveryRow>(db, 'webhook_deliveries', ref.id);
    if (!delivery) return null;
    const hook = one<WebhookRow>(db, 'SELECT workspace_id, organization_id FROM webhook_endpoints WHERE id = ?', delivery.webhook_id);

    return { body: serializeDeliveries(db, [delivery])[0], ...webhookScope(db, hook ?? { workspace_id: delivery.workspace_id, organization_id: null }) };
  },
  email(db, ref) {
    const email = row<OutboxRow>(db, 'outbox_emails', ref.id);

    return email ? { body: emailRecord(email), ...(ref.scope ?? { workspaceId: null, organizationId: null }) } : null;
  },
  audit_export(db, ref) {
    const exp = row<ExportRow>(db, 'audit_exports', ref.id);

    return exp ? { body: serializeExport(exp), workspaceId: null, organizationId: exp.organization_id } : null;
  },
};

export function snapshot(db: DatabaseSync, ref: AuditRef, view: View): Snapshot | null {
  return LOADERS[ref.type](db, ref, view);
}
