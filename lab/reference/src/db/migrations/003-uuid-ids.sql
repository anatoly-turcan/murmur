ALTER TABLE users RENAME TO v1_users;
ALTER TABLE api_keys RENAME TO v1_api_keys;
ALTER TABLE organizations RENAME TO v1_organizations;
ALTER TABLE org_memberships RENAME TO v1_org_memberships;
ALTER TABLE org_events RENAME TO v1_org_events;
ALTER TABLE workspaces RENAME TO v1_workspaces;
ALTER TABLE memberships RENAME TO v1_memberships;
ALTER TABLE projects RENAME TO v1_projects;
ALTER TABLE tasks RENAME TO v1_tasks;
ALTER TABLE comments RENAME TO v1_comments;
ALTER TABLE activity_events RENAME TO v1_activity_events;
ALTER TABLE webhook_endpoints RENAME TO v1_webhook_endpoints;
ALTER TABLE webhook_deliveries RENAME TO v1_webhook_deliveries;
ALTER TABLE webhook_attempts RENAME TO v1_webhook_attempts;
ALTER TABLE outbox_emails RENAME TO v1_outbox_emails;
ALTER TABLE digest_runs RENAME TO v1_digest_runs;
ALTER TABLE reminder_runs RENAME TO v1_reminder_runs;

CREATE TABLE legacy_ids (
  kind TEXT NOT NULL,
  legacy_id INTEGER NOT NULL,
  uuid TEXT NOT NULL,
  PRIMARY KEY (kind, legacy_id)
) WITHOUT ROWID;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  digest_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deactivated_at INTEGER
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_key TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'team', 'business')),
  owner_id TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE org_memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('org_owner', 'org_admin', 'billing', 'org_member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id)
) WITHOUT ROWID;

CREATE TABLE org_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('organization', 'org_member')),
  target_id TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_key TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT REFERENCES organizations(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
) WITHOUT ROWID;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_key TEXT NOT NULL,
  description TEXT,
  creator_id TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  title_fold TEXT NOT NULL,
  description TEXT,
  description_fold TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
  labels TEXT NOT NULL DEFAULT '[]',
  labels_fold TEXT NOT NULL DEFAULT '[]',
  assignee_id TEXT REFERENCES users(id),
  creator_id TEXT NOT NULL REFERENCES users(id),
  due_date TEXT,
  estimate_minutes INTEGER,
  budget_currency TEXT,
  budget_minor TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  body_fold TEXT NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('workspace', 'member', 'project', 'task', 'comment', 'webhook')),
  target_id TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL
);

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id),
  organization_id TEXT REFERENCES organizations(id),
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((workspace_id IS NULL) <> (organization_id IS NULL))
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  workspace_id TEXT,
  activity_event_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'succeeded', 'dead', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  series_failures INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  job_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE webhook_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT CHECK (outcome IN ('success', 'failure', 'timeout', 'error')),
  status_code INTEGER,
  error TEXT,
  UNIQUE (delivery_id, number)
);

CREATE TABLE outbox_emails (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  template TEXT NOT NULL,
  subject TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  sink_written INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE digest_runs (user_id TEXT NOT NULL, local_date TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, local_date)) WITHOUT ROWID;
CREATE TABLE reminder_runs (task_id TEXT NOT NULL, due_date TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, due_date)) WITHOUT ROWID;
