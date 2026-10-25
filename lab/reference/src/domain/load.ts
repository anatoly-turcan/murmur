import { one } from '../db/sql.ts';
import { forbidden, gone, notFound } from '../http/errors.ts';
import type { Ctx } from '../http/types.ts';
import { loadOrganization, readsEveryWorkspace, workspaceRoleFor } from './orgs.ts';
import { atLeast } from './roles.ts';
import type { CommentRow, DeliveryRow, OrgRole, ProjectRow, Role, TaskRow, WebhookRow, WorkspaceRow } from './rows.ts';
import type { Id } from '../ids/uuid.ts';

export interface WorkspaceChain {
  workspace: WorkspaceRow;
  role: Role;
}

export interface ProjectChain extends WorkspaceChain {
  project: ProjectRow;
}

export interface TaskChain extends ProjectChain {
  task: TaskRow;
}

export interface CommentChain extends TaskChain {
  comment: CommentRow;
}

export interface WebhookChain {
  webhook: WebhookRow;
  parent: { deleted_at: number | null };
  role: Role;
}

export interface DeliveryChain extends WebhookChain {
  delivery: DeliveryRow;
}

function byId<T>(ctx: Ctx, table: string, id: Id): T {
  const row = one<T>(ctx.db, `SELECT * FROM ${table} WHERE id = ?`, id);
  if (!row) throw notFound();

  return row;
}

export function loadWorkspace(ctx: Ctx, id: Id): WorkspaceChain {
  const row = one<WorkspaceRow & { my_role: Role | null; org_role: OrgRole | null }>(
    ctx.db,
    `SELECT w.*, m.role AS my_role, om.role AS org_role FROM workspaces w
       LEFT JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ?1
       LEFT JOIN org_memberships om ON om.organization_id = w.organization_id AND om.user_id = ?1
      WHERE w.id = ?2`,
    ctx.me().id,
id,
  );
  const role = row ? workspaceRoleFor(row.my_role, row.org_role) : null;
  if (!row || !role) throw notFound();
  const { my_role: _member, org_role: _org, ...workspace } = row;

  return { workspace, role };
}

export function loadProject(ctx: Ctx, id: Id): ProjectChain {
  const project = byId<ProjectRow>(ctx, 'projects', id);

  return { ...loadWorkspace(ctx, project.workspace_id), project };
}

export function loadTask(ctx: Ctx, id: Id): TaskChain {
  const task = byId<TaskRow>(ctx, 'tasks', id);

  return { ...loadProject(ctx, task.project_id), task };
}

export function loadComment(ctx: Ctx, id: Id): CommentChain {
  const comment = byId<CommentRow>(ctx, 'comments', id);

  return { ...loadTask(ctx, comment.task_id), comment };
}

function webhookParent(ctx: Ctx, webhook: WebhookRow): Omit<WebhookChain, 'webhook'> {
  if (webhook.workspace_id !== null) {
    const { workspace, role } = loadWorkspace(ctx, webhook.workspace_id);

    return { parent: workspace, role };
  }
  const { org, role } = loadOrganization(ctx, webhook.organization_id!);

  return { parent: org, role: readsEveryWorkspace(role) ? 'admin' : 'viewer' };
}

export function loadWebhook(ctx: Ctx, id: Id): WebhookChain {
  const webhook = byId<WebhookRow>(ctx, 'webhook_endpoints', id);

  return { ...webhookParent(ctx, webhook), webhook };
}

export function loadDelivery(ctx: Ctx, webhookId: Id, deliveryId: Id): DeliveryChain {
  const chain = loadWebhook(ctx, webhookId);
  const delivery = one<DeliveryRow>(ctx.db, 'SELECT * FROM webhook_deliveries WHERE id = ? AND webhook_id = ?', deliveryId, webhookId);
  if (!delivery) throw notFound();

  return { ...chain, delivery };
}

export function assertLive(...rows: { deleted_at: number | null }[]): void {
  if (rows.some((r) => r.deleted_at !== null)) throw gone();
}

export function assertRole(role: Role | null, minimum: Role): void {
  if (!atLeast(role, minimum)) throw forbidden();
}
