import type { DatabaseSync } from 'node:sqlite';
import { one, scalar } from '../db/sql.ts';
import { detail, validationFailed, type ApiError } from '../http/errors.ts';
import type { Plan } from './rows.ts';
import type { Id } from '../ids/uuid.ts';

export const PLANS: readonly Plan[] = ['free', 'team', 'business'];

export interface PlanLimits {
  max_workspaces: number | null;
  max_members_per_workspace: number | null;
  max_webhooks_per_workspace: number | null;
  api_requests_per_minute: number;
}

const LIMITS: Record<Plan, PlanLimits> = {
  free: { max_workspaces: 3, max_members_per_workspace: 10, max_webhooks_per_workspace: 2, api_requests_per_minute: 300 },
  team: { max_workspaces: 20, max_members_per_workspace: 100, max_webhooks_per_workspace: 10, api_requests_per_minute: 1200 },
  business: { max_workspaces: null, max_members_per_workspace: null, max_webhooks_per_workspace: 50, api_requests_per_minute: 6000 },
};

export function limitsOf(plan: Plan): PlanLimits {
  return LIMITS[plan];
}

export function planLimitExceeded(path: string, limit: number): ApiError {
  return validationFailed([detail(path, 'plan_limit_exceeded', { limit, message: 'The organization plan does not allow more.' })]);
}

function workspacePlan(db: DatabaseSync, workspaceId: Id): Plan {
  return one<{ plan: Plan }>(db, 'SELECT o.plan FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE w.id = ?', workspaceId)!.plan;
}

function assertBelow(limit: number | null, used: number, path: string): void {
  if (limit !== null && used >= limit) throw planLimitExceeded(path, limit);
}

export function assertWorkspaceCapacity(db: DatabaseSync, organizationId: Id, plan: Plan): void {
  const used = scalar<number>(db, 'SELECT count(*) FROM workspaces WHERE organization_id = ? AND deleted_at IS NULL', organizationId) ?? 0;
  assertBelow(limitsOf(plan).max_workspaces, used, 'organization_id');
}

export function assertMemberCapacity(db: DatabaseSync, workspaceId: Id): void {
  const used = scalar<number>(db, 'SELECT count(*) FROM memberships WHERE workspace_id = ?', workspaceId) ?? 0;
  assertBelow(limitsOf(workspacePlan(db, workspaceId)).max_members_per_workspace, used, 'email');
}

export function assertWebhookCapacity(db: DatabaseSync, workspaceId: Id): void {
  const used = scalar<number>(db, 'SELECT count(*) FROM webhook_endpoints WHERE workspace_id = ?', workspaceId) ?? 0;
  assertBelow(limitsOf(workspacePlan(db, workspaceId)).max_webhooks_per_workspace, used, 'url');
}
