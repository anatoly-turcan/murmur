-- created_at holds Temporal.Instant.toString()
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX todos_done ON todos (done);

CREATE TABLE audit_log (
  event_id TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT ';'
);
