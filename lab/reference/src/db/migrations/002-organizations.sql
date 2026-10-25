CREATE TABLE organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_key TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'team', 'business')),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX organizations_slug_live ON organizations(slug_key) WHERE deleted_at IS NULL;

CREATE TABLE org_memberships (
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('org_owner', 'org_admin', 'billing', 'org_member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id)
) WITHOUT ROWID;
CREATE INDEX org_memberships_user ON org_memberships(user_id, organization_id);
CREATE INDEX org_memberships_order ON org_memberships(organization_id, joined_at, user_id);
CREATE UNIQUE INDEX org_memberships_one_owner ON org_memberships(organization_id) WHERE role = 'org_owner';

CREATE TABLE org_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  type TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('organization', 'org_member')),
  target_id INTEGER NOT NULL,
  changes TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL
);
CREATE INDEX org_events_time ON org_events(organization_id, occurred_at, id);

ALTER TABLE workspaces ADD COLUMN organization_id INTEGER REFERENCES organizations(id);
CREATE INDEX workspaces_org ON workspaces(organization_id, id);

CREATE TABLE webhook_endpoints_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id),
  organization_id INTEGER REFERENCES organizations(id),
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((workspace_id IS NULL) <> (organization_id IS NULL))
);
INSERT INTO webhook_endpoints_next (id, workspace_id, url, events, secret, active, created_at, updated_at)
  SELECT id, workspace_id, url, events, secret, active, created_at, updated_at FROM webhook_endpoints;
DELETE FROM sqlite_sequence WHERE name = 'webhook_endpoints_next';
INSERT INTO sqlite_sequence (name, seq) SELECT 'webhook_endpoints_next', seq FROM sqlite_sequence WHERE name = 'webhook_endpoints';
DROP TABLE webhook_endpoints;
ALTER TABLE webhook_endpoints_next RENAME TO webhook_endpoints;
CREATE INDEX webhook_endpoints_ws ON webhook_endpoints(workspace_id, id);
CREATE INDEX webhook_endpoints_org ON webhook_endpoints(organization_id, id);

CREATE TABLE webhook_deliveries_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL,
  workspace_id INTEGER,
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
INSERT INTO webhook_deliveries_next SELECT * FROM webhook_deliveries;
DELETE FROM sqlite_sequence WHERE name = 'webhook_deliveries_next';
INSERT INTO sqlite_sequence (name, seq) SELECT 'webhook_deliveries_next', seq FROM sqlite_sequence WHERE name = 'webhook_deliveries';
DROP TABLE webhook_deliveries;
ALTER TABLE webhook_deliveries_next RENAME TO webhook_deliveries;
CREATE INDEX deliveries_hook ON webhook_deliveries(webhook_id, created_at, id);
CREATE INDEX deliveries_ws_open ON webhook_deliveries(workspace_id) WHERE status IN ('pending', 'in_progress');
