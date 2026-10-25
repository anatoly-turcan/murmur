CREATE TABLE audit_entries (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'api_key')),
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  api_key_id TEXT,
  ip TEXT,
  request_id TEXT,
  organization_id TEXT,
  workspace_id TEXT,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore', 'transfer', 'revoke', 'claim', 'deliver', 'send')),
  before TEXT,
  after TEXT,
  diff TEXT NOT NULL
);
CREATE INDEX audit_ws_time ON audit_entries(workspace_id, occurred_at, id) WHERE workspace_id IS NOT NULL;
CREATE INDEX audit_org_time ON audit_entries(organization_id, occurred_at, id) WHERE organization_id IS NOT NULL;
CREATE INDEX audit_actor_time ON audit_entries(actor_id, occurred_at, id) WHERE actor_id IS NOT NULL;
CREATE INDEX audit_request ON audit_entries(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX audit_resource ON audit_entries(resource_id, occurred_at);
CREATE INDEX audit_time ON audit_entries(occurred_at);

CREATE TABLE audit_exports (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  since INTEGER NOT NULL,
  until INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
  entry_count INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX audit_exports_org ON audit_exports(organization_id, created_at);

CREATE TABLE audit_export_chunks (
  export_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (export_id, seq)
) WITHOUT ROWID;

CREATE TABLE jobs_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('webhook_delivery', 'email', 'digest', 'reminder', 'maintenance', 'audit_retention', 'audit_export')),
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
INSERT INTO jobs_next SELECT id, type, status, payload, run_at, attempt_count, last_error, queue_key, queue_pos, locked_by, locked_at, created_at, updated_at FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_next RENAME TO jobs;
CREATE INDEX jobs_claim ON jobs(status, run_at, id);
CREATE INDEX jobs_queue ON jobs(queue_key, queue_pos) WHERE queue_key IS NOT NULL;
