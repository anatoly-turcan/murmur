import type { Id } from '../ids/uuid.ts';

export type { Id };

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export type OrgRole = 'org_owner' | 'org_admin' | 'billing' | 'org_member';

export type Plan = 'free' | 'team' | 'business';

export interface UserRow {
  id: Id;
  email: string;
  email_key: string;
  name: string;
  timezone: string;
  digest_enabled: number;
  created_at: number;
  updated_at: number;
  deactivated_at: number | null;
}

export interface ApiKeyRow {
  id: Id;
  user_id: Id;
  name: string;
  prefix: string;
  secret_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface WorkspaceRow {
  id: Id;
  name: string;
  slug: string;
  slug_key: string;
  owner_id: Id;
  organization_id: Id;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface OrganizationRow {
  id: Id;
  name: string;
  slug: string;
  slug_key: string;
  plan: Plan;
  owner_id: Id;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface OrgMembershipRow {
  organization_id: Id;
  user_id: Id;
  role: OrgRole;
  joined_at: number;
}

export interface MembershipRow {
  workspace_id: Id;
  user_id: Id;
  role: Role;
  joined_at: number;
}

export interface ProjectRow {
  id: Id;
  workspace_id: Id;
  name: string;
  slug: string;
  slug_key: string;
  description: string | null;
  creator_id: Id;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface TaskRow {
  id: Id;
  project_id: Id;
  workspace_id: Id;
  title: string;
  title_fold: string;
  description: string | null;
  description_fold: string | null;
  status: 'open' | 'in_progress' | 'done';
  labels: string;
  labels_fold: string;
  assignee_id: Id | null;
  creator_id: Id;
  due_date: string | null;
  estimate_minutes: number | null;
  budget_currency: string | null;
  budget_minor: string | null;
  version: number;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface CommentRow {
  id: Id;
  task_id: Id;
  workspace_id: Id;
  author_id: Id;
  body: string;
  body_fold: string;
  edited: number;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface WebhookRow {
  id: Id;
  workspace_id: Id | null;
  organization_id: Id | null;
  url: string;
  events: string;
  secret: string;
  active: number;
  created_at: number;
  updated_at: number;
}

export type DeliveryStatus = 'pending' | 'in_progress' | 'succeeded' | 'dead' | 'cancelled';

export interface DeliveryRow {
  id: Id;
  webhook_id: Id;
  workspace_id: Id | null;
  activity_event_id: Id;
  event: string;
  payload: string;
  status: DeliveryStatus;
  attempt_count: number;
  series_failures: number;
  next_attempt_at: number | null;
  job_id: number;
  created_at: number;
  completed_at: number | null;
}

export interface AttemptRow {
  id: number;
  delivery_id: Id;
  number: number;
  started_at: number;
  finished_at: number | null;
  outcome: 'success' | 'failure' | 'timeout' | 'error' | null;
  status_code: number | null;
  error: string | null;
}

export interface ActivityRow {
  id: Id;
  workspace_id: Id;
  type: string;
  actor_id: Id;
  target_type: string;
  target_id: Id;
  changes: string;
  occurred_at: number;
}

export interface OrgEventRow {
  id: Id;
  organization_id: Id;
  type: string;
  actor_id: Id;
  target_type: string;
  target_id: Id;
  changes: string;
  occurred_at: number;
}
