CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE clock (id INTEGER PRIMARY KEY CHECK (id = 1), override_ms INTEGER);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  digest_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deactivated_at INTEGER
);
CREATE UNIQUE INDEX users_email_live ON users(email_key) WHERE deactivated_at IS NULL;

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_keys_user ON api_keys(user_id, created_at, id);

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_key TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX workspaces_slug_live ON workspaces(slug_key) WHERE deleted_at IS NULL;
CREATE INDEX workspaces_owner ON workspaces(owner_id);

CREATE TABLE memberships (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
) WITHOUT ROWID;
CREATE INDEX memberships_user ON memberships(user_id, workspace_id);
CREATE INDEX memberships_order ON memberships(workspace_id, joined_at, user_id);
CREATE UNIQUE INDEX memberships_one_owner ON memberships(workspace_id) WHERE role = 'owner';

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_key TEXT NOT NULL,
  description TEXT,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX projects_slug_live ON projects(workspace_id, slug_key) WHERE deleted_at IS NULL;
CREATE INDEX projects_ws_slug ON projects(workspace_id, slug, id);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  title_fold TEXT NOT NULL,
  description TEXT,
  description_fold TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
  labels TEXT NOT NULL DEFAULT '[]',
  labels_fold TEXT NOT NULL DEFAULT '[]',
  assignee_id INTEGER REFERENCES users(id),
  creator_id INTEGER NOT NULL REFERENCES users(id),
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
CREATE INDEX tasks_project_created ON tasks(project_id, created_at, id);
CREATE INDEX tasks_project_updated ON tasks(project_id, updated_at, id);
CREATE INDEX tasks_project_due ON tasks(project_id, due_date, id);
CREATE INDEX tasks_ws_created ON tasks(workspace_id, created_at, id);
CREATE INDEX tasks_ws_updated ON tasks(workspace_id, updated_at, id);
CREATE INDEX tasks_ws_due ON tasks(workspace_id, due_date, id);
CREATE INDEX tasks_assignee ON tasks(assignee_id, workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_due_open ON tasks(due_date) WHERE deleted_at IS NULL AND status <> 'done' AND assignee_id IS NOT NULL;

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  body_fold TEXT NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX comments_task ON comments(task_id, created_at, id);
CREATE INDEX comments_ws ON comments(workspace_id, task_id) WHERE deleted_at IS NULL;

CREATE TABLE activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('workspace', 'member', 'project', 'task', 'comment', 'webhook')),
  target_id INTEGER NOT NULL,
  changes TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL
);
CREATE INDEX activity_ws_time ON activity_events(workspace_id, occurred_at, id);
CREATE INDEX activity_target ON activity_events(target_type, target_id, occurred_at);

CREATE TABLE webhook_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX webhook_endpoints_ws ON webhook_endpoints(workspace_id, id);

CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  activity_event_id INTEGER NOT NULL,
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
CREATE INDEX deliveries_hook ON webhook_deliveries(webhook_id, created_at, id);
CREATE INDEX deliveries_ws_open ON webhook_deliveries(workspace_id) WHERE status IN ('pending', 'in_progress');

CREATE TABLE webhook_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT CHECK (outcome IN ('success', 'failure', 'timeout', 'error')),
  status_code INTEGER,
  error TEXT,
  UNIQUE (delivery_id, number)
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('webhook_delivery', 'email', 'digest', 'reminder', 'maintenance')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'dead')),
  payload TEXT NOT NULL DEFAULT '{}',
  run_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queue_key TEXT,
  queue_pos INTEGER,
  locked_by TEXT,
  locked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_claim ON jobs(status, run_at, id);
CREATE INDEX jobs_queue ON jobs(queue_key, queue_pos) WHERE queue_key IS NOT NULL;

CREATE TABLE worker_instances (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL);

CREATE TABLE outbox_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  template TEXT NOT NULL,
  subject TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  sink_written INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX outbox_order ON outbox_emails(sent_at, id);

CREATE TABLE digest_runs (user_id INTEGER NOT NULL, local_date TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, local_date)) WITHOUT ROWID;
CREATE TABLE reminder_runs (task_id INTEGER NOT NULL, due_date TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, due_date)) WITHOUT ROWID;

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'done')),
  status INTEGER,
  headers TEXT,
  body TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
) WITHOUT ROWID;
CREATE INDEX idempotency_expiry ON idempotency_keys(expires_at);

CREATE TABLE rate_limit_counters (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
) WITHOUT ROWID;
