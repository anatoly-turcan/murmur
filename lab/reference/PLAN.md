# Taskwell reference implementation — architecture plan

The architecture and build plan the agents that wrote the reference worked from. Purpose: prove every one of the 692 hidden-suite tests is passable by an implementation that
follows `SPEC.md`, and give the perf harness (`harness/measure-perf.ts`) a target. Correctness to SPEC beats
passing tests: where a test and SPEC disagree, implement SPEC and add an entry to `DISPUTES.md`.

Ground rules (all agents):

- Node 26, TypeScript run natively (erasable syntax only: no `enum`, `namespace`, decorators, parameter properties;
  `import type` for types; explicit `.ts` in relative imports; `"type": "module"`).
- Zero runtime dependencies: `node:http`, `node:sqlite` (`DatabaseSync`), `node:crypto`, `node:fs`, global `fetch`,
  `Temporal`, `Intl`. Dev only: `typescript@7.0.2`, `@types/node@26.6.5`. pnpm.
- Small focused functions, thin orchestrators, no comments unless they say what the code cannot, blank line before
  `return` unless it is the only statement in the block.
- Never edit anything under `lab/suite`, `SPEC.md`, `SMOKE.md`.

---

## 1. Process model

### 1.1 Processes

| Process | Command | What it does |
|---|---|---|
| API | `./bin/api` → `node src/api.ts` | Migrates the schema, then serves HTTP from **one** Node process with **one** `DatabaseSync` connection. |
| Worker ×2 | `./bin/worker` → `node src/worker.ts` | Registers itself in `worker_instances`, heartbeats, recovers interrupted jobs, claims and runs jobs, runs the minute scheduler outside test mode. |
| Setup | `./bin/setup` → `node src/setup.ts` | Migrates the schema and exits (idempotent). `pnpm install` is only needed for typecheck. |

All three share one SQLite file named by `TASKWELL_DATABASE_URL` (accepted forms: `sqlite:///abs/path.db`,
`sqlite:relative/path.db`, `file:path.db`, bare path). Every connection sets:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```

### 1.2 Concurrency discipline

- API request handlers are **synchronous after the body has been read**. No `await` between the first read of
  domain state and the commit. Because the API is a single process, this alone makes claims, If-Match checks,
  slug/email uniqueness races, transfers and idempotency reservations atomic among API requests. Unique partial
  indexes (section 2) are the backstop.
- Every write goes through `immediate(db, fn)` (`BEGIN IMMEDIATE … COMMIT`, `ROLLBACK` on throw). Never use a
  deferred transaction that later upgrades to a write lock: under WAL that returns `SQLITE_BUSY` immediately,
  regardless of `busy_timeout`.
- Workers never hold a transaction across network I/O. A webhook attempt is: tx (open attempt) → HTTP → tx
  (finish attempt + job row).
- `ApiError` thrown inside `immediate` rolls back; the pipeline renders it.

### 1.3 Jobs table and polling

Every asynchronous effect is a row in `jobs` written **in the same transaction** as the request that caused it,
so "a successful response implies the job is listed and will run" holds trivially.

Job types: `email`, `webhook_delivery`, `digest`, `reminder`, `maintenance`.
Job statuses: `pending`, `running`, `succeeded`, `dead`.

Serial queues (generic, kernel): a job may carry `queue_key` (webhooks use `webhook:<endpoint id>`) and
`queue_pos`. Jobs that share a `queue_key` run strictly in `queue_pos` order, one at a time. A pending job is
**claimable** when `status='pending' AND run_at <= now` and, if it has a queue key, no other job of the same key is
`running` and none with a smaller `queue_pos` is `pending`. Keeping `run_at` honest for blocked jobs:

- enqueue into a queue: `run_at = max(now, max(run_at of pending jobs in that queue))`;
- whenever a queued job is rescheduled to `T`: `UPDATE jobs SET run_at = max(run_at, T) WHERE queue_key = ? AND
  status = 'pending' AND queue_pos > ?`;
- moving a job to the end of its queue (redeliver): `queue_pos = (SELECT max(queue_pos) FROM jobs WHERE
  queue_key = ?) + 1`, `run_at` as for enqueue.

This makes G4's check ("after drain no pending job has `run_at <= now`") hold, because followers of a retrying
delivery carry the retry time.

Claim (worker, inside `immediate`): select the first claimable job ordered `run_at, id`, set `status='running'`,
`attempt_count = attempt_count + 1`, `locked_by = <worker id>`, `locked_at = <real ms>`.

Polling cadence: each worker keeps up to 8 jobs in flight. When a claim finds nothing it sleeps 25 ms
(test mode) or 200 ms (otherwise) before trying again. A newly created job is picked up well inside the 2 s
target, and `drain` returns quickly.

Execution contract (see 4.3 for types): the handler does its I/O, then returns a `JobOutcome` whose `apply()` is
run by the runner **in the same transaction** as the job-row update, followed by `afterCommit()` for non-DB
effects (email sink append). Outcomes: `succeeded`, `retry {runAt, error}`, `dead {error}`. A handler that throws
gets the generic schedule of SPEC 12: retry after 10 s, 1 min, 5 min, 30 min, `dead` after the 5th failure.
Webhook handlers never throw; they return outcomes on the SPEC 8.3 schedule.

### 1.4 Worker liveness and recovery

- `worker_instances(id, pid, started_at, heartbeat_at)` with **real** time. Heartbeat every 500 ms.
- Recovery sweep every 500 ms, run by every worker: a `running` job is interrupted when its `locked_by` row is
  missing, its heartbeat is older than 2 s (real time), or `process.kill(pid, 0)` says the pid is gone.
  Recovery happens in one `immediate` tx per job: the handler's `onInterrupted(job, now)` decides the outcome
  (webhooks: close the open attempt with outcome `error`, error `worker terminated`, `finished_at = now`,
  schedule the retry from `now`), default is `retry` at `now`.
- The 60 s (application clock) recovery bound is met because detection is real-time and immediate.
- On SIGTERM a worker stops claiming, waits up to 3 s for in-flight jobs, deletes its `worker_instances` row,
  exits. SIGKILL is handled by the sweep.

### 1.5 Application clock

- `clock` table, single row `{id: 1, override_ms}`. `appNow(db)` returns `override_ms ?? Date.now()`; outside test
  mode the row is never read and `Date.now()` is used.
- API: `ctx.now` is read once at the start of each request and used for every timestamp the request writes
  and every rule it evaluates (rate-limit windows, overdue, idempotency expiry).
- Workers: read `appNow` at each claim, each attempt start/finish and each recovery decision.
- Because the override lives in the database, a clock change made by the API is visible to both workers as soon as
  the `PUT`/`advance`/`DELETE` commits, i.e. before the call returns (SPEC 13.4).
- Per-operation timeouts (webhook timeout, drain 30 s wait, heartbeat staleness) use real time.

### 1.6 Test endpoints across processes

All `/__test/*` routes are served by the API and only registered when `TASKWELL_TEST_MODE=true`.

| Endpoint | Implementation |
|---|---|
| `POST /__test/reset` | One `immediate` tx: `DELETE FROM` every data table (everything except `schema_migrations`, `meta`, `worker_instances`), clock override cleared. Workers holding a running job find their completion `UPDATE` hits zero rows and move on. |
| `GET/PUT/DELETE /__test/clock`, `POST /__test/clock/advance` | Read/write the `clock` row. `PUT` parses any offset, normalises to UTC ms. `advance` requires a non-negative integer (`422 out_of_range` at `seconds`), `400 clock_not_overridden` when not frozen. |
| `POST /__test/scheduler/tick` | Runs `runSchedulerEvaluation(db, now)` synchronously in the API process: every registered scheduler rule (digests, reminders) inserts into its dedupe table with `INSERT OR IGNORE` and enqueues one job per inserted row, all in one tx; the response sums the counters. Concurrent ticks serialise in the single API process and dedupe at the table level. |
| `POST /__test/jobs/drain` | Async loop in the API: every 25 ms count `running` jobs plus claimable (due, not blocked) `pending` jobs at the current application clock; return as soon as both are 0, or after 30 s real time with `drained: false`. `dead` is the total dead count. Other requests keep being served between polls. |
| `GET /__test/jobs` | `SELECT … ORDER BY id DESC LIMIT 1000`, optional `status` filter. `run_at` rendered as a timestamp. |
| `GET/DELETE /__test/emails` | Read / empty `outbox_emails` (which is also the dedupe-key record). |
| `POST /__test/seed` | `409 database_not_empty` if `users` has any row; otherwise delegates to the slice that registers a seeder (slice A). |

### 1.7 Scheduler

`runSchedulerEvaluation(db, now)` runs every rule registered by slices (`SchedulerRule[]`). Outside test mode every
worker runs it once per real minute boundary; dedupe tables make double runs harmless. Outside test mode the same
driver also enqueues one `maintenance` job per hour (only if none is pending) that purges expired
idempotency keys and rate-limit windows older than 2 minutes. In test mode nothing is automatic.

---

## 2. SQLite schema

One migration file, `src/db/migrations/001-schema.sql`, owned by the kernel and containing every table below.
Slices may add `src/db/migrations/1NN-<slice>-<what>.sql` files (indexes only, ideally) — new files never conflict.
`schema_migrations(version TEXT PRIMARY KEY, applied_at INTEGER)` tracks applied files.

Conventions: all timestamps are `INTEGER` epoch milliseconds (application clock); dates are `TEXT 'YYYY-MM-DD'`;
booleans `INTEGER 0/1`; ids `INTEGER PRIMARY KEY AUTOINCREMENT` (never reused after reset or delete).
`*_fold` columns hold `fold(text)` (NFKC + full case folding, section 3.11) for uniqueness and search.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);           -- cursor_secret (random, set on first migrate)
CREATE TABLE clock (id INTEGER PRIMARY KEY CHECK (id = 1), override_ms INTEGER);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL,                 -- fold(email)
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
  secret_hash TEXT NOT NULL UNIQUE,        -- sha256 hex of the full secret
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_keys_user ON api_keys(user_id, created_at, id);

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_key TEXT NOT NULL,                  -- fold(slug)
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
  labels TEXT NOT NULL DEFAULT '[]',       -- JSON array as stored (NFC, trimmed)
  labels_fold TEXT NOT NULL DEFAULT '[]',  -- JSON array of fold(label)
  assignee_id INTEGER REFERENCES users(id),
  creator_id INTEGER NOT NULL REFERENCES users(id),
  due_date TEXT,
  estimate_minutes INTEGER,
  budget_currency TEXT,
  budget_minor INTEGER,                    -- ≤ 10^18, fits int64; read with BigInt
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
  events TEXT NOT NULL,                    -- JSON array exactly as accepted (["*"] kept as is)
  secret TEXT NOT NULL,                    -- plaintext: needed for HMAC; never logged or returned after create
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX webhook_endpoints_ws ON webhook_endpoints(workspace_id, id);

CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL,             -- no FK: endpoint DELETE hard-deletes rows explicitly
  workspace_id INTEGER NOT NULL,
  activity_event_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,                   -- exact body bytes sent on every attempt
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'succeeded', 'dead', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,  -- across all series
  series_failures INTEGER NOT NULL DEFAULT 0, -- failures in the current series of six
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
  finished_at INTEGER,                     -- NULL while in flight; recovery closes it
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
  locked_at INTEGER,                       -- real time
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
  scope TEXT NOT NULL,                     -- 'user:<id>' or 'ip:<addr>'
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'done')),
  status INTEGER,
  headers TEXT,                            -- JSON of stored response headers (content-type, etag)
  body TEXT,                               -- exact response text
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,             -- created_at + 24 h (application clock)
  PRIMARY KEY (scope, key)
) WITHOUT ROWID;
CREATE INDEX idempotency_expiry ON idempotency_keys(expires_at);

CREATE TABLE rate_limit_counters (
  bucket TEXT NOT NULL,                    -- 'ipu:<ip>' | 'ipa:<ip>' | 'key:<key id>' | 'kws:<key id>:<ws id>'
  window_start INTEGER NOT NULL,           -- floor(now / 60000) * 60000
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
) WITHOUT ROWID;
```

Notes:

- **Soft deletes**: `deleted_at` on workspaces, projects, tasks, comments. Deleting a parent sets only the parent's
  `deleted_at`; children are hidden by joins (`task visible ⇔ task, project and workspace all have deleted_at
  NULL`). Restoring the parent therefore revives exactly what was visible at deletion; individually deleted
  children keep their own `deleted_at`. Users are deactivated (`deactivated_at`), API keys revoked
  (`revoked_at`), webhook endpoints hard-deleted together with their deliveries, attempts and jobs.
- **Cursors** are stateless (signed, section 3.7); no table. The HMAC secret is `meta.cursor_secret`.
- **Activity** rows are immutable and never deleted except by `/__test/reset`.
- **Money aggregates** are summed in JS `BigInt` (statements opt in with `setReadBigInts(true)`); SQLite `SUM`
  would overflow int64 on H2's "beyond 64-bit" test.
- **Labels filter**: `EXISTS (SELECT 1 FROM json_each(t.labels_fold) WHERE value = ?)` per `label` parameter.

---

## 3. HTTP kernel conventions

### 3.1 Request pipeline (`src/http/pipeline.ts`)

```
read body (≤ 64 KiB buffered, rest drained)      → BodyState (deferred: too_large | bad_media | malformed | json | none)
match route (method + path)                       → route | allowedMethods (405) | none (404)
client ip                                         → socket peer, or first X-Forwarded-For value when TRUST_PROXY
authenticate (auth routes and unmatched /v1 paths) → {user, key} | missing | invalid
scope: route.scope?.(db, params) → workspace id   → role of actor in it (null when non-member or nonexistent)
rate limit (unless exempt)                        → check every bucket; 429 if any exhausted (nothing counted)
                                                    else increment all buckets
401 if auth failed                                → unauthenticated | invalid_api_key
404 / 405 if no route                              (after auth, so unknown /v1 paths without a key are 401)
idempotency (route.idempotent + valid header)     → replay | 422 reused | 409 in progress | reserve
handler(ctx)                                      → Result | ApiError
finalise                                          → JSON envelope, ETag, RateLimit-* (+Retry-After on 429),
                                                    store idempotent response on 2xx / release reservation otherwise,
                                                    one log line
```

Anything unexpected → `500 internal_error` (logged with stack, no secrets).

Handlers enforce the rest of SPEC 6.3 precedence by calling things in this order:

1. load the target chain (object + ancestors); non-member or missing → `404 not_found`;
2. any deleted object in the chain → `410 gone` (restore endpoints skip the check for the object being restored,
   but not for its ancestors: restoring a task of a deleted project is `410`, see L2 below);
3. role / ownership rules → `403 forbidden` (includes `include_deleted=true` for non-admins);
4. `ctx.input()` → throws the deferred `400` / `413` / `415` in this order: `413 payload_too_large`,
   `415 unsupported_media_type`, `400 invalid_header` (If-Match, Idempotency-Key), `400 invalid_query`,
   `400 malformed_json`; then `ctx.page()` for list routes → `400 invalid_cursor` / `cursor_mismatched`;
5. body validation → one `422 validation_failed` carrying **every** detail (DSL details plus domain details such as
   `not_assignable`, `invalid_project`, `user_not_found`, `not_member`, `too_many_items`);
6. state conflicts inside the write transaction → `409` (`version_conflict`, `slug_taken`, `already_member`, …).

The 404 message is one constant string so a non-member's response is byte-identical (modulo digits) to the
nonexistent-object response (D1).

### 3.2 Router (`src/http/router.ts`)

- Routes are declared as data: `{ method, path: '/v1/tasks/:id', … }`. `:name` params match only canonical
  positive integers `1 … 2^53−1` (no leading zeros, no sign); anything else falls through, so `/v1/users/me` is
  matched by its literal route and `/v1/tasks/abc` is `404`.
- Literal segments win over params. A path that matches some route with another method → `405
  method_not_allowed` (with `Allow` header).
- Duplicate `method + path` registrations throw at startup (protects the slice merge).

### 3.3 Bodies, media types, JSON

- Body cap is 65,536 bytes (exactly 64 KiB is accepted, 65,537 is `413`). The reader keeps consuming past the cap
  but stops buffering.
- A request "carries a body" when it has a non-empty payload. Media type check: `type/subtype` must be
  `application/json` (parameters such as `charset` ignored). An empty payload means "no body": `{}` for
  routes with `body: 'json'`.
- Routes declare `body: 'json' | 'none'`. `none` routes (claim, restore, redeliver, DELETE, GET) never read the
  payload, so a stray body never causes 413/415/400.
- Valid JSON that is not an object → `422 invalid_type` at path `''`.

### 3.4 Error envelope (`src/http/errors.ts`)

`{"error": {"code", "message", "details"?}}`; `details` only when non-empty; every detail has `path` and `code`
and may carry extra keys (`current_version`, `assignee_id`, `workspace_ids`). Factories: `notFound()`, `gone()`,
`forbidden()`, `unauthenticated()`, `invalidApiKey()`, `methodNotAllowed()`, `payloadTooLarge()`,
`unsupportedMediaType()`, `badRequest(code, message)`, `validationFailed(details)`, `conflict(code, message,
details?)`, `rateLimited()`, `internalError()`. Detail paths: dot notation for fields, `[n]` for indexes, `''` for
the whole body.

### 3.5 Validation DSL (`src/http/validate.ts`)

```ts
const taskCreate = {
  title: str({ min: 1, max: 200 }),
  description: str({ max: 20_000, nullable: true }),
  status: oneOf(['open', 'in_progress', 'done']),
  labels: list(str({ min: 1, max: 40 }), { max: 20, uniqueBy: fold }),
  assignee_id: id({ nullable: true }),
  due_date: date({ nullable: true }),
  estimate_minutes: int({ min: 0, max: 100_000, nullable: true }),
  budget: money({ nullable: true }),
} satisfies FieldSpecs;

const { values, details } = validateBody(body, taskCreate, { required: ['title'] });
```

- Strings: NFC-normalise, trim Unicode `White_Space` (regex `\p{White_Space}`, **not** `String#trim`, which keeps
  U+0085), then measure in code points. Empty after trim → `too_short`; absent → `required`; wrong JSON type →
  `invalid_type`; `null` on a non-nullable field → `not_nullable`.
- `int` accepts JSON integers only (`1.5`, `"1"` → `invalid_type`); out of range → `out_of_range`.
- `date` requires `YYYY-MM-DD` (`invalid_format`) and a real calendar date (`invalid_date`).
- `list`: non-array → `invalid_type`; over max → `too_many_items` at the list path; under min → `too_short`;
  duplicates (by `uniqueBy`) → `duplicate` at `path[index of the second]`; item errors at `path[i]`.
- `money`: `{currency, amount}` both required (`required` at `budget.currency` / `budget.amount`); unknown nested
  keys → `unknown_field` at `budget.<key>`; `amount` not a string → `invalid_type`; pattern
  `^[0-9]{1,15}(\.[0-9]{1,6})?$` fails → `invalid_format` only; unknown currency → `unsupported_currency` at
  `budget.currency`; too many decimals for the currency → `too_many_decimals` at `budget.amount`.
- Unknown top-level fields → `unknown_field` at the field name. All details are collected, never short-circuited.
- `validateBody` returns `{ values, details }` (values only for present, valid keys); the handler appends domain
  details and calls `throwIfInvalid(details)`.

### 3.6 Query parameters (`src/http/query.ts`)

Each list route declares a `QuerySpec`; `limit` (int 1–100, default 20) and `cursor` are implicit for routes with
`list: true`. Types: `int`, `bool` (`true|false` only), `enumList` (comma-separated, each from a set), `enumOne`,
`date`, `timestamp` (any offset, normalised), `id`, `idOr(['me', 'none'])`, `text` (search `q`), `repeat(text)`
(`label`). An unknown parameter, a repeated non-repeatable parameter, or a value outside its type/set → deferred
`400 invalid_query`. Search's `q` length rule (2–100 code points after trim/NFC) is also `400 invalid_query`.

### 3.7 Cursors and pagination (`src/http/pagination.ts`)

- Keyset pagination only; never offsets. Each list fetches `limit + 1` rows ordered by its total ordering with
  `id` (members: `user_id`) last; the extra row decides `next_cursor`.
- Cursor format: `c_<base64url(payload)>.<base64url(hmac)>`, `payload = JSON {e, f, k}`:
  - `e` — endpoint binding: route `method + path template` plus its path params, e.g.
    `GET /v1/projects/:id/tasks#id=10`;
  - `f` — first 16 hex chars of sha256 over the canonical JSON of the parsed query **minus** `limit` and `cursor`
    (filters, sort, include_deleted, `q`);
  - `k` — keyset values of the last returned row, e.g. `[created_at, id]`.
  - `hmac` — first 12 bytes of HMAC-SHA256(payload, `meta.cursor_secret`).
- Decode order: shape/base64/JSON/HMAC failure → `400 invalid_cursor`; `e` differs → `400 cursor_mismatched`;
  `f` differs → `400 invalid_cursor`.
- Keyset predicates are expanded explicitly per ordering (SQLite row values only where all directions agree):
  `created_at desc, id desc` → `(created_at, id) < (?, ?)`; `due_date asc nulls last, id asc` → order by
  `coalesce(due_date, '9999-12-31~')`; search → `(rank > ?) OR (rank = ? AND updated_at < ?) OR (rank = ? AND
  updated_at = ? AND id < ?)`.
- Stability (C1) follows from keyset + immutable `created_at` / monotonic `updated_at` + `id` tiebreak.
- API: `ctx.page()` → `{ limit, after: unknown[] | null }`; `ctx.pageOf(rows, keyOf)` → `{ data, next_cursor }`.

### 3.8 Authentication (`src/http/auth.ts`)

- Header must match `^Bearer twl_[A-Za-z0-9]{40}$` exactly, else `unauthenticated` (missing or malformed).
- Lookup by `sha256(secret)`; unknown, revoked, or user deactivated → `invalid_api_key`.
- Secrets: `twl_` + 40 chars from `crypto.randomInt` over `[A-Za-z0-9]`; `prefix` = first 12 chars.
- `last_used_at` is written when null or older than 60 s (application clock), in its own tiny tx.
- Revocation/deactivation are visible to the next request because the key is looked up every time (no cache).

### 3.9 Rate limiting (`src/http/rate-limit.ts`)

Buckets per SPEC 6.8, window `floor(now / 60 s)` on the application clock:

| Bucket key | When | Limit |
|---|---|---|
| `ipu:<ip>` | no valid key (missing, malformed, invalid; also `POST /v1/users`) | 30 |
| `ipa:<ip>` | valid key | 1,200 |
| `key:<key id>` | valid key and (route has no scope, or actor is not a member of the scope workspace) | 120 |
| `kws:<key id>:<ws id>` | valid key, actor is a member of the scope workspace | owner/admin 600, member 300, viewer 60 |

- One `immediate` tx: read all applicable counters; if any is at its limit → `429 rate_limited`, nothing is
  incremented; else upsert `count + 1` for each.
- Headers on every non-exempt response: the bucket with the fewest remaining (after counting) →
  `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset = ceil((window_end − now) / 1000)` (60 at `:00`).
  `429` adds `Retry-After` equal to `RateLimit-Reset`.
- Exempt: `/healthz`, `/__test/*` (route flag `rateLimit: false`).
- Scope resolvers (`src/http/scopes.ts`, kernel): `byWorkspace(':id')`, `byProject`, `byTask`, `byComment`,
  `byWebhook` — one indexed lookup each, ignoring deleted state; a nonexistent object yields `null`.

### 3.10 Idempotency (`src/http/idempotency.ts`)

- Only routes flagged `idempotent: true` (the eight creates). Header value must be 1–255 chars of printable ASCII
  `[\x20-\x7e]`; otherwise the request proceeds **without** idempotency and `ctx.input()` throws
  `400 invalid_header`. Every other route never reads the header.
- Scope: `user:<actor id>`, or `ip:<client ip>` for `POST /v1/users`.
- Fingerprint: sha256 of `METHOD + ' ' + pathname + '\n' + canonicalJson(parsedBody)` (raw text when the body is not
  JSON). Method + path are part of it, so the same key and body on another endpoint is
  `422 idempotency_key_reused` (L3, documented in the README).
- Flow: row exists and `expires_at > now`: `done` + same fingerprint → replay stored status, headers and exact
  body text plus `Idempotent-Replayed: true`; `done` + different → `422 idempotency_key_reused`;
  `in_progress` → `409 idempotency_in_progress`. Absent or expired → upsert an `in_progress` reservation
  (committed), run the handler, then store the response on 2xx or delete the reservation on anything else.
- Rate-limit headers are computed fresh on a replay; the stored headers are `content-type` and `etag` only.

### 3.11 Text, slugs, emails (`src/text/*`)

- `nfcTrim(s)`, `codePoints(s)`.
- `fold(s)`: `s.normalize('NFKC')`, then for each code point `cp.toUpperCase().toLowerCase()` (per code point, so
  no Final_Sigma context; gives `ß → ss`, `ς → σ`, `İ → i̇`). Documented deviation: Turkish dotless ı folds to `i`.
- Slug syntax: `^[\p{Ll}\p{Lm}\p{Lo}\p{Nd}]+(?:-[\p{Ll}\p{Lm}\p{Lo}\p{Nd}]+)*$`u after NFC, ≤ 50 code points
  (`too_long`; `invalid_format` otherwise). Uniqueness on `fold(slug)`.
- Derived slugs: `fold(name)`, runs of `[^\p{L}\p{N}]` → `-`, trim hyphens, cut to 50 code points, re-trim, empty →
  fallback (`workspace` / `project`); if taken, first free `-2`, `-3`, … with the base cut to `50 − suffix length`
  and re-trimmed.
- Email: ≤ 254 code points (`too_long`, checked first), exactly one `@` with non-empty sides (`invalid_format`);
  `email_key = fold(email)`.
- Timezones: valid iff `new Intl.DateTimeFormat('en-US', { timeZone })` accepts it and it is not an offset string
  (`^[+-]`); Link names such as `US/Eastern` are accepted and stored as given.

### 3.12 Time helpers (`src/time/*`)

`iso(ms)` → `YYYY-MM-DDTHH:mm:ss.sssZ`; `parseTimestamp(text)` → ms or null (any offset; requires a date, a time
and an offset or `Z`); `isRealDate(text)`; `localDate(ms, tz)` and `localMinuteOfDay(ms, tz)` via
`Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz)` (zone rules of that date, DST-correct).

### 3.13 ETag / If-Match (`src/http/headers.ts`)

- Every 2xx returning one versioned object (workspace, project, task, comment) sets `ETag: "<version>"`
  (`created(body, version)` / `ok(body, version)` helpers).
- `If-Match` is parsed only on routes flagged `ifMatch: true` (PATCH/DELETE of workspace, project, task, comment).
  Accepted form: `^"(0|[1-9][0-9]*)"$` exactly; anything else → `400 invalid_header`. Mismatch with the current
  version inside the write tx → `409 version_conflict` with
  `details: [{path: 'version', code: 'stale', current_version}]`.

### 3.14 Versioning, events, emails (kernel domain services)

- Every change to a versioned object runs `version = version + 1, updated_at = now` exactly once, in the same
  statement as the change (claims, deletes, restores, unassignment, transfer, empty PATCH).
- `recordEvent(tx, ctx, { workspaceId, type, target, changes, data })` (`src/domain/events.ts`): inserts the
  activity row and, when `type` is one of the 13 deliverable events, one `webhook_deliveries` row + one queued
  `webhook_delivery` job per **active** endpoint of the workspace whose `events` include the type (`["*"]` = the
  13). Payload text is built once, with the delivery id:
  `{delivery_id, event, occurred_at, workspace_id, actor: {id, name, deleted}, data}`. `data` is supplied by the
  caller: `{task, changes?}` / `{comment, task_id, changes?}` / `{project, changes?}` / `{member}`; objects
  serialised as their GET representation, tasks with `overdue` in the **actor's** timezone. Returns the event id.
- `enqueueEmail(tx, { template, toUserId, subject, dedupeKey, data, requireMemberOf? })`
  (`src/domain/emails.ts`): one `email` job. At execution the worker skips (succeeds without writing) when the
  recipient is deactivated or, with `requireMemberOf`, no longer a member; otherwise `INSERT … ON CONFLICT
  (dedupe_key) DO NOTHING` with `sent_at = now`, then appends the JSON line to `TASKWELL_EMAIL_SINK_PATH` after
  commit and sets `sink_written = 1`.
- `cancelOpenDeliveries(tx, workspaceId, now)` (`src/domain/deliveries.ts`): pending/in_progress deliveries →
  `cancelled` + `completed_at`, their jobs → `succeeded` with `last_error = 'cancelled'` (used by workspace delete).

### 3.15 Handler shapes (`src/http/types.ts`)

```ts
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Route {
  method: Method;
  path: string;
  auth?: 'required' | 'none';             // default 'required'
  rateLimit?: boolean;                     // default true
  scope?: ScopeResolver;                   // workspace id for rate-limit role buckets
  body?: 'json' | 'none';                  // default 'none' for GET/DELETE, 'json' otherwise
  idempotent?: boolean;
  ifMatch?: boolean;
  list?: boolean;
  query?: QuerySpec;
  handle(ctx: Ctx): Result | Promise<Result>;
}

interface Ctx {
  db: DatabaseSync;
  config: Config;
  now: number;
  ip: string;
  actor: { user: UserRow; keyId: number } | null;
  params: Record<string, number>;
  scopeRole: Role | null;                  // actor's role in the scope workspace, if any
  input(): { query: QueryValues; body: Record<string, unknown>; ifMatch: number | null };
  page(): { limit: number; after: unknown[] | null };
  pageOf<T>(rows: T[], keyOf: (row: T) => unknown[]): { data: T[]; next_cursor: string | null };
}

interface Result { status: number; body?: unknown; etag?: number; headers?: Record<string, string> }
```

Domain loaders (`src/domain/load.ts`) return chains and guards throw in precedence order:
`loadTaskChain(ctx, id)` → `{ task, project, workspace, role }` (404 for missing or non-member);
`assertLive(...rows)` → 410; `assertRole(role, 'member')` → 403. Same for workspace, project, comment, webhook,
delivery.

---

## 4. Module map

```
lab/reference/
  package.json  tsconfig.json  README.md  PLAN.md  DISPUTES.md
  bin/lib.sh                     shared: cd to repo root, ensure node ≥ 26 (nvm fallback)
  bin/setup  bin/api  bin/worker  bin/test
  scripts/suite.sh               <id> <port> [tests…]: fresh DB in reference-out/<id>/, api + 2 workers,
                                 exports SUITE_WORKER_STOP_CMD/START_CMD + SUITE_EMAIL_SINK_PATH, runs the suite,
                                 kills everything (trap)
  scripts/workers.sh             start|stop for the two workers of one run (pid files) — used by suite.sh
  src/
    api.ts  worker.ts  setup.ts  entry points: config → db → migrate → serve | work
    config.ts                    TASKWELL_* parsing with defaults (SPEC 13.2)
    log.ts                       JSON-line logger with level filter, redaction of twl_ secrets
    routes.ts                    kernelRoutes ++ slices[a..d].routes, duplicate check
    db/connection.ts             open DatabaseSync from URL, pragmas
    db/migrate.ts                apply migrations/*.sql in order, seed meta.cursor_secret and clock row
    db/tx.ts                     immediate(db, fn), one(), all(), run() helpers
    db/migrations/001-schema.sql
    time/clock.ts                appNow(db, config), setOverride, advance, clearOverride
    time/format.ts               iso, parseTimestamp, isRealDate
    time/zones.ts                isValidTimezone, localDate, localMinuteOfDay
    text/normalize.ts            nfcTrim, codePoints, fold
    text/slug.ts                 isValidSlug, deriveSlug, slugKey
    text/email.ts                emailProblem, emailKey
    money/money.ts               CURRENCIES, parseAmount → bigint minor, formatMoney, meanHalfAwayFromZero
    http/server.ts               node:http server, graceful close
    http/pipeline.ts             orchestrator of 3.1
    http/router.ts               compile + match routes
    http/body.ts                 bounded reader + BodyState
    http/errors.ts               ApiError + factories
    http/respond.ts              writer: envelope, ETag, rate-limit headers, Allow
    http/headers.ts              parseIfMatch, idempotencyKeyProblem, clientIp
    http/query.ts                QuerySpec DSL
    http/validate.ts             body DSL (3.5)
    http/pagination.ts           cursor sign/verify, binding, pageOf
    http/auth.ts                 authenticate, touchLastUsed, generateSecret, hashSecret
    http/rate-limit.ts           buckets, check-and-count, header selection
    http/idempotency.ts          fingerprint, lookup/reserve/complete/release
    http/scopes.ts               scope resolvers
    http/context.ts              Ctx construction
    http/types.ts                Route, Ctx, Result, QuerySpec types
    domain/roles.ts              Role, rank, atLeast
    domain/load.ts               chain loaders + assertLive/assertRole/assertMember
    domain/access.ts             roleOf(db, wsId, userId), isAssignable(db, wsId, userId)
    domain/events.ts             recordEvent + webhook fan-out, EVENT_TYPES, WEBHOOK_EVENTS
    domain/emails.ts             enqueueEmail, template subjects
    domain/deliveries.ts         cancelOpenDeliveries, deleteEndpointDeliveries
    jobs/types.ts                JobRow, JobHandler, JobOutcome, JobResult
    jobs/queue.ts                enqueue, enqueueSerial, reschedule (+ follower run_at bump), moveToEnd
    jobs/claim.ts                claimNext, countDue (shared with drain)
    jobs/runner.ts               worker loop: slots, execute, apply outcome, generic retry schedule
    jobs/recovery.ts             heartbeat, stale detection, onInterrupted dispatch
    jobs/registry.ts             kernel handlers + slices' jobHandlers
    jobs/email-job.ts            email handler (recipient checks, outbox insert, sink append)
    jobs/maintenance-job.ts      purge expired idempotency keys + old rate-limit windows
    scheduler/scheduler.ts       runSchedulerEvaluation, minute driver, hourly maintenance enqueue
    slices/types.ts              Slice interface
    slices/a.ts b.ts c.ts d.ts   one registration file per slice (kernel ships them empty)
    features/health/routes.ts
    features/testing/routes.ts   /__test/* (1.6)
    features/users/              routes.ts register.ts me.ts read.ts serialize.ts fields.ts
    features/api-keys/           routes.ts list.ts create.ts revoke.ts serialize.ts
    features/workspaces/         routes.ts create.ts list.ts read.ts serialize.ts fields.ts
    features/members/            routes.ts add.ts list.ts serialize.ts
    features/projects/           routes.ts create.ts read.ts serialize.ts fields.ts
    features/tasks/              routes.ts create.ts read.ts serialize.ts fields.ts (create + patch specs)
    features/comments/           routes.ts create.ts read.ts serialize.ts
    features/webhooks/           routes.ts create.ts deliveries-list.ts serialize.ts fields.ts
  test/                          unit tests (node:test) for text, money, cursor, router, validate, queue
```

Slice registration contract (`src/slices/types.ts`):

```ts
interface Slice {
  routes: Route[];
  jobHandlers: Partial<Record<JobType, JobHandler>>;
  schedulerRules: SchedulerRule[];
  seed?: (db: DatabaseSync, now: number) => SeedResult;
}

interface SchedulerRule { counter: 'digests_created' | 'reminders_created'; run(db: DatabaseSync, now: number): number }

interface JobHandler {
  run(job: JobRow, ctx: JobContext): Promise<JobOutcome>;
  onInterrupted?(db: DatabaseSync, job: JobRow, now: number): JobOutcome;
}

interface JobOutcome { result: JobResult; apply?: () => void; afterCommit?: () => void }
type JobResult = { status: 'succeeded' } | { status: 'retry'; runAt: number; error: string } | { status: 'dead'; error: string };
interface JobContext { db: DatabaseSync; config: Config; now(): number; log: Logger; begin<T>(fn: () => T): T }
```

`JobContext.begin` runs `fn` in an `immediate` tx (used by the webhook handler to open an attempt before the HTTP
call).

---

## 5. Build order: kernel, then four parallel slices

### 5.1 Kernel (one agent, lands on `main` first)

Everything in section 4 except the slice files, plus these endpoints with full SPEC behaviour (validation, events,
emails, idempotency, ETag):

| Area | Endpoints |
|---|---|
| Health, test | `GET /healthz` (`503 database_unavailable` on a failing `SELECT 1`), all `/__test/*` of 1.6 (seed delegates to `slice.seed`, `409 database_not_empty` handled by the kernel) |
| Users | `POST /v1/users`, `GET /v1/users/me`, `PATCH /v1/users/me`, `GET /v1/users/{id}` |
| API keys | `GET/POST /v1/users/me/api-keys`, `DELETE /v1/users/me/api-keys/{id}` |
| Workspaces | `POST /v1/workspaces` (`workspace.created`), `GET /v1/workspaces` (incl. `include_deleted`), `GET /v1/workspaces/{id}` |
| Members | `GET /v1/workspaces/{id}/members`, `POST /v1/workspaces/{id}/members` (`member.added`, `member_added` email) |
| Projects | `POST /v1/workspaces/{id}/projects` (`project.created`), `GET /v1/projects/{id}` |
| Tasks | `POST /v1/projects/{id}/tasks` (`task.created`, `task_assigned` email keyed by that event id), `GET /v1/tasks/{id}` |
| Comments | `POST /v1/tasks/{id}/comments` (`comment.created`, `comment_added` emails to assignee + creator minus commenter, `requireMemberOf`), `GET /v1/comments/{id}` |
| Webhooks | `POST /v1/workspaces/{id}/webhooks` (`webhook.created`, secret generated as 32 random bytes hex when omitted), `GET /v1/webhooks/{id}/deliveries` |

Worker side: runner, recovery, registry, email job, maintenance job, scheduler driver. No webhook or digest
handlers (slices D and C register them).

Kernel also writes `scripts/suite.sh`, `scripts/workers.sh`, `bin/*`, README (install, migrate, run api and
workers, env vars, assumptions), and unit tests for the pure libraries.

Kernel must turn green (kernel-owned suite files, 269 tests):

| File | Tests | Expectation with kernel alone |
|---|---:|---|
| `errors-auth.test.ts` | 60 | all (auth precedes routing for `/v1`) |
| `errors-test-endpoints.test.ts` | 14 | all |
| `errors-users.test.ts` | 22 | all except `DELETE /v1/users/me → 409 sole_owner` (slice A) |
| `j-rate-limit.test.ts` | 13 | all except where a fixture needs a slice route (`viewer.patch(project)` needs B) |
| `smoke.test.ts` | 13 | 1, 2, 3, 4, 5, 7, 8; the rest need slices |
| `errors-http.test.ts` | 147 | every row for kernel routes; machinery (413/415/400/422/unknown_field/If-Match/Idempotency-Key/cursor) is the kernel's, rows for slice routes go green as slices land |

Kernel exit check: typecheck clean, unit tests green, and the six files above at the stated level.

### 5.2 Parallel slices

Each slice works in its own git worktree branched from the kernel commit, adds **new files only**, and registers
everything in its own `src/slices/<x>.ts` (the only pre-existing file it edits). Kernel files are frozen during
the parallel phase; if a slice finds a kernel bug it may make a minimal fix in a separate commit
`fix(reference-kernel): …` so the integrator can resolve it once. Each slice runs the suite with
`scripts/suite.sh <slice id> <port> tests/<file>.test.ts` on its own port and DB.

"Owned" files must be green with kernel + that slice alone, except rows that depend on another slice's endpoints
(named under "shared"). "Shared" files are checked after integration by the integrator.

Test counts per slice (owned): A 112, B 118, C 99, D 94 (= 423; kernel 269; total 692).

#### Slice A — Workspace lifecycle, membership management, deactivation, reference seed

Endpoints: `PATCH /v1/workspaces/{id}` (`workspace.updated`, If-Match, slug rules), `DELETE /v1/workspaces/{id}`
(`workspace.deleted`, version bump, `cancelOpenDeliveries`), `POST /v1/workspaces/{id}/restore`
(`workspace.restored`, `409 not_deleted` / `slug_taken`), `POST /v1/workspaces/{id}/transfer-ownership`
(exactly `ownership.transferred` + `member.role_changed`, version bump), `PATCH /v1/workspaces/{id}/members/{user_id}`
(`member.role_changed`; demotion to viewer unassigns), `DELETE /v1/workspaces/{id}/members/{user_id}`
(`member.removed`; leave; unassigns with the remover as actor), `DELETE /v1/users/me` (sole_owner with
`workspace_ids`, revoke keys, remove memberships as removal by the user, deactivate). Seeder for
`POST /__test/seed` (`profile: "reference"`, SPEC 14.1 sizes, direct bulk SQL in one tx, webhooks inactive, ten
users with varied roles returned with fresh API keys).

| Modules (new) |
|---|
| `src/features/workspaces/update.ts`, `src/features/workspaces/lifecycle.ts`, `src/features/workspaces/transfer.ts` |
| `src/features/members/change-role.ts`, `src/features/members/remove.ts`, `src/features/members/unassign.ts` (unassign a user's live tasks in a workspace, one `task.updated` each) |
| `src/features/users/deactivate.ts` |
| `src/features/seed/reference.ts`, `src/features/seed/generators.ts` |
| registration: `src/slices/a.ts` |

Owned suite files: `d-authorization.test.ts` (73), `errors-workspaces.test.ts` (39).

Shared: `d-authorization` D1/D3 rows hit every slice's routes (B projects/tasks, C comments, D webhooks);
`errors-users` sole_owner row (kernel file); `e-soft-delete` E1/E2 workspace rows (B owns the file);
`f-webhooks` F6 "workspace deletion cancels pending deliveries" (D owns); `errors-gone` workspace-deleted rows
(C owns); `a-concurrency` A2 workspace version on delete/restore and PATCH If-Match (B owns); `k-search` K1
deactivated author (C owns); `errors-http` / `errors-notfound` rows for A's routes.

#### Slice B — Projects and tasks

Endpoints: `GET /v1/workspaces/{id}/projects` (slug asc, include_deleted admin+), `PATCH /v1/projects/{id}`,
`DELETE /v1/projects/{id}`, `POST /v1/projects/{id}/restore`, `GET /v1/projects/{id}/summary` (BigInt
aggregates, requester-timezone overdue), `GET /v1/projects/{id}/tasks`, `GET /v1/workspaces/{id}/tasks` (all
filters, three sorts, include_deleted semantics of 7.6), `PATCH /v1/tasks/{id}` (one `task.updated` with
from/to per changed field, `completed_at`, `task_assigned` email on (re)assignment unless actor, `project_id`
move with `invalid_project`), `POST /v1/tasks/{id}/claim` (atomic, no email), `DELETE /v1/tasks/{id}` (member:
creator or assignee only), `POST /v1/tasks/{id}/restore` (assignee cleared when no longer assignable; `410` when
the project or workspace is deleted — L2, documented).

| Modules (new) |
|---|
| `src/features/projects/list.ts`, `update.ts`, `lifecycle.ts`, `summary.ts` |
| `src/features/tasks/list-query.ts` (filters, sorts, keyset; shared by both task lists), `list.ts`, `update.ts`, `diff.ts` (changes map), `claim.ts`, `lifecycle.ts` |
| registration: `src/slices/b.ts` |

Owned suite files: `errors-projects-tasks.test.ts` (58), `a-concurrency.test.ts` (22), `e-soft-delete.test.ts`
(16), `h-numbers.test.ts` (13), `c-pagination.test.ts` (9).

Shared: `a-concurrency` A2 rows on workspace/comment delete, restore and PATCH (A, C); `e-soft-delete` workspace
rows (A) and comment list include_deleted (C); `c-pagination` C2 activity ordering (C); `i-validation` I4/I5
PATCH rows (C owns); `b-time` B2 due-date change and B3 (C owns); `l-ambiguities` L2 (C owns); `smoke` 6, 9, 10;
`errors-gone` project rows (C owns); `j-rate-limit` fixture using project PATCH (kernel owns); `errors-http` /
`errors-notfound` rows for B's routes.

#### Slice C — Comments, activity, search, digests and reminders

Endpoints: `GET /v1/tasks/{id}/comments` (include_deleted admin+), `PATCH /v1/comments/{id}` (author only,
`edited`, If-Match, `comment.updated`), `DELETE /v1/comments/{id}` (`comment.deleted`), `POST
/v1/comments/{id}/restore` (`comment.restored`), `GET /v1/workspaces/{id}/activity` (filters, since inclusive /
until exclusive), `GET /v1/workspaces/{id}/search` (SPEC 11 ranking on `*_fold` columns with `instr`,
keyset over rank/updated_at/id). Scheduler rules + job handlers: `digest` (08:00 local, catch-up same day only,
`digest_runs` dedupe, data composed at execution, current timezone — L1 documented) and `reminder` (09:00 local on
the due date, `reminder_runs` dedupe, conditions re-checked at execution).

| Modules (new) |
|---|
| `src/features/comments/list.ts`, `update.ts`, `lifecycle.ts` |
| `src/features/activity/list.ts`, `src/features/activity/serialize.ts` |
| `src/features/search/search.ts`, `src/features/search/rank.ts` |
| `src/features/digest/rule.ts`, `job.ts`, `compose.ts` |
| `src/features/reminders/rule.ts`, `job.ts` |
| registration: `src/slices/c.ts` |

Owned suite files: `errors-comments-activity-search.test.ts` (29), `i-validation.test.ts` (23),
`errors-gone.test.ts` (20), `b-time.test.ts` (13), `k-search.test.ts` (9), `l-ambiguities.test.ts` (5).

Shared: `errors-gone` rows for lists of B and D and parents deleted by A/B; `i-validation` mostly exercises kernel
creates plus B's task PATCH (I4) — C verifies and reports; `b-time` B2/B3 need task PATCH (B), B3 webhook payload
(D); `l-ambiguities` L2 is B's restore; `g-side-effects` G2 digests (D owns); `c-pagination` C2 activity (B
owns); `smoke` 6, 12, 13; `d-authorization` D3 comment rows, D6 (A owns).

#### Slice D — Webhook management and the delivery worker

Endpoints: `GET /v1/workspaces/{id}/webhooks`, `GET /v1/webhooks/{id}`, `PATCH /v1/webhooks/{id}` (`url`,
`events`, `active`; `webhook.updated`), `DELETE /v1/webhooks/{id}` (`webhook.deleted`, hard delete +
`deleteEndpointDeliveries`), `GET /v1/webhooks/{id}/deliveries/{delivery_id}`, `POST
/v1/webhooks/{id}/deliveries/{delivery_id}/redeliver` (`202`, dead only, `moveToEnd`, fresh series, no event).
Job handler `webhook_delivery`: open attempt (`begin`), POST with `fetch` (`redirect: 'manual'`,
`AbortSignal.timeout(TASKWELL_WEBHOOK_TIMEOUT_MS)`, headers of 8.2, HMAC over `<ts>.<payload>` with the attempt's
application-clock seconds), classify `success | failure | timeout | error`, `apply` closes the attempt and sets
delivery status (`succeeded` + `completed_at`; `pending` + `next_attempt_at` = finished + 30 s/2 min/10 min/1 h/6 h;
`dead` after the sixth failure of the series) and the job result (`reschedule` bumps followers). A delivery
cancelled or deleted meanwhile stays cancelled/deleted. `onInterrupted`: close the open attempt as
`error` / `worker terminated` with `finished_at = now`, then the same schedule.

| Modules (new) |
|---|
| `src/features/webhooks/list.ts`, `read.ts`, `update.ts`, `remove.ts` |
| `src/features/webhooks/delivery-read.ts`, `redeliver.ts` |
| `src/features/webhooks/delivery/attempt.ts` (HTTP + signing + classification), `outcome.ts` (state transitions), `job.ts` (JobHandler), `interrupted.ts` |
| registration: `src/slices/d.ts` |

Owned suite files: `errors-notfound.test.ts` (48), `errors-webhooks.test.ts` (25), `f-webhooks.test.ts` (16),
`g-side-effects.test.ts` (5).

Shared: `errors-notfound` rows for every slice's routes (D verifies after integration); `g-side-effects` G1
emails (kernel), G2 digests (C); `f-webhooks` F6 workspace deletion (A) and project deletion (B); `b-time` B3/B4
webhook rows (C owns); `smoke` 11; `d-authorization` D3 webhook rows (A owns).

### 5.3 File overlap summary

| File | Kernel | A | B | C | D |
|---|:-:|:-:|:-:|:-:|:-:|
| `src/slices/a.ts` | create empty | edit | | | |
| `src/slices/b.ts` | create empty | | edit | | |
| `src/slices/c.ts` | create empty | | | edit | |
| `src/slices/d.ts` | create empty | | | | edit |
| everything else | kernel files frozen | new files only | new files only | new files only | new files only |

The only cross-slice coupling is through kernel modules (`domain/*`, `features/*/serialize.ts`,
`features/tasks/fields.ts`, `jobs/queue.ts`), which slices import but do not edit.

### 5.4 Integration

Merge A, B, C, D onto the kernel (conflict-free by construction), run the full suite with `scripts/suite.sh`,
fix integration bugs, then record every remaining failure either as a bug to fix or as a `DISPUTES.md` entry.

---

## 6. Decisions on SPEC ambiguities (README "Assumptions")

| Topic | Decision |
|---|---|
| L1 digest after timezone change | One digest per local date evaluated in the timezone current at evaluation time; dedupe key `daily_digest:<user>:<date>` prevents a second digest for a date. |
| L2 restore task while its project is deleted | `410 gone`: the 410 rule applies to deleted ancestors; restore only exempts the object being restored. |
| L3 idempotency fingerprint | Method + path + parsed body; same key on another endpoint → `422 idempotency_key_reused`. |
| Body precedence inside the 400/413/415 group | 413, 415, invalid_header, invalid_query, malformed_json. |
| Cursor for the same route with other path params | `400 cursor_mismatched` (endpoint binding includes path params). |
| Idempotency replay vs. later state | Replay is decided right after auth and rate limiting, before visibility checks. |
| Webhook delivery cancelled by workspace delete while in flight | Status becomes `cancelled`; the in-flight attempt is still recorded when it finishes; no retry. |
| Unknown `/v1` path | `401` without a valid key, else `404 not_found`. |
| Case folding | NFKC then per-code-point upper→lower (full folding except Turkic dotless ı). |
| API processes | One process; correctness under concurrency relies on synchronous handlers plus SQLite unique indexes. |

---

## 7. Kernel conventions (as built; slices must use these)

Signatures below are the real ones in `src/`. Where they differ from sections 3.14/3.15, this section wins.

### 7.1 Registering a slice

Each slice owns exactly one file in `src/slices/` (`a.ts`…`d.ts`) and its feature folders under `src/features/`.

```ts
// src/slices/types.ts
interface Slice {
  name: string;
  routes: Route[];
  jobHandlers: JobHandlers;               // Partial<Record<JobType, JobHandler>>; duplicates throw at boot
  schedulerRules: SchedulerRule[];
  seed?: (db: DatabaseSync, now: number) => SeedResult;   // POST /__test/seed (slice A)
}
interface SchedulerRule { counter: 'digests_created' | 'reminders_created'; run(db: DatabaseSync, now: number): number }
```

Slice routes are appended after kernel routes (`src/routes.ts`); the router rejects duplicate method+path, prefers
literal segments over `:param`, accepts only `[1-9][0-9]*` params (anything else is a 404), and answers 405 with
`Allow` when the path exists for another method. A slice that adds a method to a kernel path (e.g. `PATCH
/v1/tasks/:id`) just declares the route.

### 7.2 Routes and context (`src/http/types.ts`)

```ts
interface Route {
  method: Method; path: string;                          // '/v1/tasks/:id'
  auth?: 'required' | 'none';                            // default 'required'
  rateLimit?: boolean;                                   // default true
  scope?: ScopeResolver;                                 // byWorkspace() | byProject() | byTask() | byComment() | byWebhook()  (param default 'id')
  body?: 'json' | 'none';                                // default 'none' for GET/DELETE, else 'json'
  idempotent?: boolean; idempotencyScope?: 'user' | 'ip';
  ifMatch?: boolean;                                     // parse If-Match; malformed -> 400 invalid_header
  list?: boolean;                                        // adds LIST_QUERY (limit 1..100 default 20, cursor)
  query?: QuerySpec;                                     // unknown/repeated/bad -> 400 invalid_query
  handle(ctx: Ctx): Result | Promise<Result>;
}
interface Ctx {
  db; config; log; now: number /* application clock */; ip: string; actor: { user: UserRow; keyId: number } | null;
  params: Record<string, number>; scopeWorkspaceId: number | null; scopeRole: Role | null;
  header(name: string): string | undefined;
  me(): UserRow;                                         // actor.user, throws if unauthenticated
  input(): { query: QueryValues; body: Record<string, unknown>; ifMatch: number | null };   // memoised; throws 413/415/400/422(invalid_type at '')
  page(): { limit: number; after: unknown[] | null };    // decodes cursor (binding + filter hash) -> invalid_cursor / cursor_mismatched
  pageOf<R, T = R>(rows: R[], keyOf: (row: R) => unknown[], map?: (row: R) => T): { data: T[]; next_cursor: string | null };
}
interface Result { status: number; body?: unknown; etag?: number; headers?: Record<string, string> }
```

- Responses: `ok(body, etag?)`, `created(body, etag?)`, `accepted(body)`, `noContent()` from `src/http/respond.ts`;
  `etag` is the row `version` and becomes `ETag: "<version>"`.
- Lists: query `limit + 1` rows ordered by the key tuple, decode `ctx.page().after` into the same tuple, and return
  `ok(ctx.pageOf(rows, keyOf, serialize))`. `pageOf` trims the extra row and signs `next_cursor`.
- If-Match: route `ifMatch: true`, then in the handler
  `if (ifMatch !== null && ifMatch !== row.version) throw versionConflict(row.version)` (409 `version_conflict`, detail carries `current_version`).
- Handlers are synchronous after `ctx.input()`; wrap every write in `immediate(ctx.db, () => ...)`. Nested calls
  join the outer transaction.
- Pipeline order (fixed): body cap 64 KiB, route, IP, auth, scope/role, rate limit, 401/404/405, idempotency, handler.
  Idempotent routes store 2xx responses only; other statuses release the key.

### 7.3 Errors (`src/http/errors.ts`)

`class ApiError(status, code, message, details?, headers?)`. Factories: `notFound()`, `gone()`, `forbidden()`,
`unauthenticated()`, `invalidApiKey()`, `methodNotAllowed(allowed)`, `payloadTooLarge()`,
`unsupportedMediaType()`, `badRequest(code, message)`, `invalidQuery(message?)`, `invalidHeader(message)`,
`validationFailed(details)`, `conflict(code, message, details?)`, `rateLimited()`, `internalError()`,
`versionConflict(currentVersion)`. Helpers: `detail(path, code, extra?)`, `throwIfInvalid(details)` (422 when
non-empty; default per-code messages are filled in).

### 7.4 Validation (`src/http/validate.ts`) and queries (`src/http/query.ts`)

```ts
validateBody(body, specs, { required?: (keyof S)[] }): { values: ValuesOf<S>; details: Detail[] }
has(values, key): boolean                                // key present (distinguishes absent from null)
// fields: str({ min = 1, max }) (NFC + trim, code points), oneOf(values), int({ min, max }), bool(), id(), date(),
// email(), slug(), timezone(), money() -> { currency, minor: bigint }, list(item, { min?, max?, uniqueBy? }),
// nullable(field), custom<T>((value, path, details) => T | INVALID)
parseQuery(params, spec): QueryValues
// q.int(min, max, dflt?), q.bool(dflt?), q.enumOne(values, dflt?), q.enumList(values) (comma list, sorted, deduped),
// q.date(), q.timestamp(), q.id(), q.idOr(words), q.text(min, max, { required? }), q.raw(), q.repeat(min, max)
```

Pattern: collect `details` from `validateBody`, push cross-field or DB-dependent details (inside `immediate`),
then `throwIfInvalid(details)`.

### 7.5 Domain services (`src/domain/*`)

```ts
loadWorkspace(ctx, id): { workspace, role }               // 404 when missing or caller not a member
loadProject(ctx, id): { workspace, project, role }
loadTask(ctx, id): { workspace, project, task, role }
loadComment(ctx, id): { workspace, project, task, comment, role }
loadWebhook(ctx, id): { workspace, webhook, role }
loadDelivery(ctx, webhookId, deliveryId): { workspace, webhook, delivery, role }
assertLive(...rows: { deleted_at: number | null }[]): void   // 410 gone
assertRole(role, minimum: Role): void                     // 403 forbidden
roleOf(db, workspaceId, userId): Role | null; isMember(db, wsId, userId); isAssignable(db, wsId, userId)
atLeast(role, minimum): boolean; ROLES
recordEvent(db, now, actor: UserRow, { workspaceId, type, target: { type, id }, changes?, data? }): number
  // activity row + one delivery and one 'webhook_delivery' job (queueKey `webhook:<endpointId>`) per active
  // subscribed endpoint; payload { delivery_id, event, occurred_at, workspace_id, actor, data }. The caller puts
  // `changes` inside `data` when the webhook payload needs it; `changes` is stored on the activity row.
enqueueEmail(db, now, { template, toUserId, subject, dedupeKey, data, requireMemberOf? }): JobRef
cancelOpenDeliveries(db, workspaceId, now): number         // pending jobs -> succeeded 'cancelled'; deliveries -> cancelled
deleteEndpointDeliveries(db, webhookId): void
workspaceSlugTaken(db, slug, exceptId?), projectSlugTaken(db, wsId, slug, exceptId?), slugTaken(): ApiError,
chooseSlug(given, name, fallback, isTaken): string
actorRef(user): { id, name, deleted }; actorRefById(db, id); loadUser(db, id); DELETED_USER_NAME
```

Serializers to reuse: `serializeUser`, `serializePublicUser`, `serializeWorkspace(ws, role)`,
`serializeMember(row)` + `MEMBER_SELECT` / `loadMember`, `serializeProject(p)`,
`serializeTask(task, tz, now)` / `serializeTaskFor(ctx, task)` (overdue in the caller's timezone),
`serializeComment(db, c, author?)` / `serializeCommentRow` + `COMMENT_SELECT`, `serializeWebhook(w, includeSecret)`,
`serializeDeliveries(db, rows)`. Task column helpers: `labelColumns`, `budgetColumns`, `foldOrNull`,
`completedAtFor(status, previous, now)`; `notifyAssigned(db, now, task, actor, eventId)`.

### 7.6 Jobs (`src/jobs/*`)

```ts
enqueue(db, { type, payload?, runAt, now, queueKey? }): { id, runAt }   // queued jobs never run before their predecessors
moveToEnd(db, jobId, now): JobRef; bumpFollowers(db, queueKey, queuePos, runAt)
genericFailure(attemptCount, now, error): JobResult         // 10 s, 1 m, 5 m, 30 m, then dead
interface JobHandler {
  run(job: JobRow, ctx: JobContext): Promise<JobOutcome>;   // ctx: { db, config, log, workerId, now(), begin(fn) }
  onInterrupted?(db, job, now): JobOutcome;                  // recovery of a dead worker's job; default retry now
}
interface JobOutcome { result: JobResult; apply?: () => void; afterCommit?: () => void }
// JobResult = { status: 'succeeded' } | { status: 'retry'; runAt; error } | { status: 'dead'; error }
succeeded(extra?): JobOutcome; jobPayload<T>(job): T
```

The runner (8 slots per worker) claims only job types that have a handler. It runs `run()` outside any
transaction, then in one `immediate` transaction it checks that it still owns the job, calls `apply()` and writes
the result; `afterCommit()` runs only when that commit happened. A thrown error becomes `genericFailure`. Do
network I/O in `run()` and DB writes in `apply()`.

### 7.7 Infrastructure helpers

`one<T>/all<T>/run/insert/scalar<T>(db, sql, ...params)` (cached statements; `run` returns changes, `insert`
returns the row id), `placeholders(n)`, `bool(b)`, `immediate(db, fn)`, `inTransaction(db)`,
`appNow(db, testMode)`, `iso(ms)`, `isoOrNull`, `parseTimestamp`, `isRealDate`, `localDate(ms, tz)`,
`localMinuteOfDay(ms, tz)`, `localMidnightMs(date, tz)`, `localTimeMs(date, hour, tz)`, `isValidTimezone`,
`nfcTrim`, `fold`, `codePoints`, `sliceCodePoints`, `slugBase/withSuffix/firstFreeSlug/slugProblem/slugKey`,
`emailProblem/emailKey`, `money(currency, minor)`, `parseMinor`, `formatMinor`, `decimalsOf`,
`meanHalfAwayFromZero`. Times are stored as epoch milliseconds (INTEGER); `budget_minor` is TEXT (decimal string)
so it can be read without BigInt mode.

### 7.8 Running the suite against the reference

`scripts/suite.sh <run-id> <port> [tests/<file>.test.ts ...]` creates a fresh DB in
`lab/reference-out/<run-id>/`, starts the API and two workers (test mode, trust proxy, 1 s webhook timeout),
runs the hidden suite with worker stop/start hooks, and kills everything on exit.
