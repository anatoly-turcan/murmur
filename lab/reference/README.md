# Taskwell reference implementation (sealed during the experiment)

The lab's own implementation of `SPEC.md`, used only to validate the hidden suite (`lab/suite`) and the perf
harness. Architecture and build plan: `PLAN.md`. Test-vs-SPEC disagreements: `DISPUTES.md`.

Status: SPEC.md v1 complete (slices A-D, `PLAN.md` section 5.2) plus the phase-2 change requests CR-1
(organizations), CR-2 (UUIDv7 public identifiers) and CR-3 (audit log), all from `../experiment/PHASE2.md`.

## Requirements

- Linux, Node.js 26 or newer (the `bin/*` shims fall back to `nvm use 26` when `node` on `PATH` is older).
- pnpm (only for `pnpm install`, which fetches the dev-only `typescript` and `@types/node` for typechecking).
- No runtime dependencies and no database server.

## Supported database engines

SQLite only, via the built-in `node:sqlite`. One database file is shared by the API and up to two workers
(WAL mode, `busy_timeout` 5 s). Provisioning means choosing a writable path; the schema is created on first start.

`TASKWELL_DATABASE_URL` examples: `sqlite:///var/lib/taskwell/taskwell.db`, `sqlite:data/taskwell.db`,
`file:data/taskwell.db`, or a bare path.

## Install and migrate

```bash
pnpm install                                          # dev tooling only
TASKWELL_DATABASE_URL=sqlite:data/taskwell.db ./bin/setup   # creates or migrates the schema (idempotent)
```

## Run

```bash
export TASKWELL_DATABASE_URL=sqlite:data/taskwell.db
./bin/api        # HTTP API on TASKWELL_BIND:TASKWELL_PORT (migrates first if needed)
./bin/worker     # one worker; run a second instance in another shell if desired
```

Both workers and the API share the one SQLite file. Workers heartbeat every 500 ms; a worker silent for 5 s (or
whose pid is gone) has its running jobs recovered by any live worker. Outside test mode each worker also drives
the scheduler once per minute.

Helper scripts:

```bash
scripts/workers.sh start <run dir>   # ensure two workers run (WORKER_COUNT) from <run dir>/env.sh; pid files and logs in <run dir>
scripts/workers.sh stop <run dir>    # kill -9 every worker started from <run dir>
scripts/suite.sh <run id> <port> [tests/<file>.test.ts ...]   # fresh DB + API + 2 workers, run the hidden suite
```

## Tests

```bash
./bin/test       # typecheck (when dev deps are installed) and unit tests
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TASKWELL_DATABASE_URL` | required | SQLite database location (see above). |
| `TASKWELL_BIND` | `0.0.0.0` | Listen address. |
| `TASKWELL_PORT` | `8080` | Listen port. |
| `TASKWELL_TEST_MODE` | `false` | `true` enables `/__test/*` and disables the automatic scheduler tick. |
| `TASKWELL_EMAIL_SINK_PATH` | unset | Every outbox email is also appended to this file as one JSON line. |
| `TASKWELL_WEBHOOK_TIMEOUT_MS` | `5000` | Per-attempt webhook receiver timeout. |
| `TASKWELL_TRUST_PROXY` | `false` | Use the first `X-Forwarded-For` value as the client IP. |
| `TASKWELL_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `TASKWELL_AUDIT_RETENTION_DAYS` | `365` | Audit entries older than this many days (application clock) are purged. `scripts/suite.sh` sets `30`. |

## Assumptions where SPEC.md is silent

- L1 digest after a timezone change: one digest per local date, evaluated in the timezone current at evaluation
  time; the dedupe key `daily_digest:<user>:<date>` prevents a second digest for that date.
- L2 restoring a task whose project is deleted: `410 gone`.
- L3 idempotency fingerprint: method + path + canonical parsed body; the same key on another endpoint is
  `422 idempotency_key_reused`. Keys are scoped to the user (or the client IP for registration).
- Precedence inside the 400/413/415 group: 413, 415, invalid_header, invalid_query, malformed_json.
- A cursor reused on the same route with other path parameters is `400 cursor_mismatched`; a cursor whose filters
  differ from the request is `400 invalid_cursor`.
- Idempotent replay is decided after auth and rate limiting, before visibility checks.
- Unknown `/v1` paths: `401` without a valid key, otherwise `404 not_found`.
- Case folding: NFKC, then per-code-point upper-then-lower, then NFKC (full folding without Turkic rules).
- One API process; concurrency safety relies on synchronous handlers, `BEGIN IMMEDIATE` and unique indexes.
- Timestamps are stored as epoch milliseconds; budgets are stored as decimal strings of minor units and handled as
  `BigInt`, so amounts up to 15 integer digits never lose precision.
- A worker claims only job types it has a handler for, so a pending job without a handler stays pending.
- Emails are written to the outbox and the sink line is appended inside the same write-locked transaction; a job
  recovered from a dead worker checks the sink before appending, so each email appears exactly once.

### Workspaces, members and deactivation (slice A)

- Member management checks the requester's role before looking up the target: a member or viewer gets `403` for
  `PATCH`/`DELETE /v1/workspaces/{id}/members/{user_id}` even when `user_id` is not a member; admins and owners
  get `404 not_found` for a non-member target.
- `PATCH /v1/workspaces/{id}/members/{user_id}` with `{}` or with the member's current role returns `200` and
  records no event; only an actual change records `member.role_changed` (`changes.role` from/to).
- `POST /v1/workspaces/{id}/transfer-ownership` naming the current owner is `409 sole_owner` (it would leave the
  workspace without an owner). `ownership.transferred` carries `changes.role` of the new owner (previous role to
  `owner`); `member.role_changed` carries the previous owner's `owner` to `admin`.
- `PATCH /v1/workspaces/{id}` records `workspace.updated` with only the fields whose value changed.
- Unassignment on removal, leave, demotion to viewer and deactivation covers every task of the workspace whose own
  `deleted_at` is null, including tasks hidden by a deleted project, so a later project restore cannot bring back
  a task assigned to a non-member.
- Deactivation removes memberships in deleted workspaces too (recording `member.removed` there); any webhook
  delivery that removal would create in a deleted workspace is cancelled at once, as workspace deletion requires.
- Webhook payloads of events produced by a deactivation show the actor as they were at that moment; the activity
  feed shows them as `Deleted user` because actors are rendered from the current user state.

### Projects and tasks (slice B)

- A claim records `task.updated` with only `assignee_id` in `changes`; a `PATCH` records from/to for each changed
  field, and an empty `PATCH` records `changes: {}`.
- Reassigning a task sends `task_assigned`, except when assigning yourself or claiming.

### Comments, activity, search, digests and reminders (slice C)

- A comment `PATCH` containing `body` sets `edited: true`; `comment.updated` lists `body` in `changes` only when
  the text changed.
- A digest's `activity_count` counts events from the 24 hours before the digest job runs, up to and including that
  moment.
- Digest and reminder jobs re-check their conditions when they run, then queue the email as a separate `email` job.

### Webhooks (slice D)

- A dead delivery's job is marked `dead`; redeliver moves it back to pending at the end of the queue, keeps the
  delivery's `created_at` and ignores any request body.
- `attempt_count` increases when an attempt starts. A timed-out attempt's `error` reads
  `no response within <ms> ms`.
- A delivery cancelled while its attempt is in flight keeps the attempt record and its job finishes `succeeded`.
- Webhook `PATCH` and `DELETE` take no `If-Match` and return no `ETag` (SPEC 6.6 does not list webhooks).

### Organizations (CR-1)

- Migration `002-organizations.sql` adds the organization tables and rebuilds `webhook_endpoints` (workspace or
  organization owner) and `webhook_deliveries` (nullable `workspace_id`). Its backfill runs in the same transaction,
  only when the migration is applied, so a second `./bin/setup` changes nothing. Every workspace, deleted ones too,
  gets a live `free` organization named after it, with the workspace slug (suffixed `-2`, `-3`… if another
  organization already holds it), owned by the workspace owner, with every other member as `org_member` (joined at
  their workspace join time). The migration records no organization events.
- Workspace and organization membership are independent: adding a workspace member does not add them to the
  organization. A workspace ownership transfer to someone who is not an organization member is `422
  validation_failed` (`user_id`, `not_org_member`): a workspace owner must be an org member, and only `org_owner`
  and `org_admin` may grow the organization, so the transfer does not enroll the target.
- Plan limits come from the plan; `limits` is not stored. Counted against them: live workspaces of the
  organization, workspace memberships including the owner, and the workspace's webhooks. Org-level webhooks have
  no limit. Restoring a workspace is not checked against the limit. `plan_limit_exceeded` details use path
  `organization_id` (workspace create), `email` (member add) or `url` (webhook create).
- `POST /v1/workspaces` with an `organization_id` of an organization the caller is not in is
  `422 validation_failed` (`organization_id`, `invalid_organization`); `billing` is `403`; a deleted organization
  is `410`.
- `org_owner` and `org_admin` read every workspace of the organization as `viewer` (`my_role: "viewer"`), including
  the member list, activity, search and the workspace-scoped rate-limit bucket at the viewer rate. They are not
  listed in `GET /v1/workspaces`. `GET /v1/organizations/{id}/workspaces` lists live workspaces by id with the
  caller's workspace role (or `viewer` for owner/admin, otherwise `null`).
- Organization bucket `org:<id>`: counted on every request that resolves to a workspace in which the caller has a
  (possibly org-derived) role, after the IP and per-key buckets. `usage.api_requests_last_minute` is that bucket's
  count in the current fixed minute window. The reference dataset's organizations are on `business`, so the perf
  load never meets the organization bucket.
- Org members: `POST` takes `{email, role}` with `role` one of `org_admin`, `billing`, `org_member` (`org_owner`
  is `invalid_enum` on `POST` and `PATCH`; ownership moves only by transfer). Items are
  `{user: {id, name, email}, role, joined_at}`, ordered by `joined_at, user_id`. Managing members is
  `org_owner`/`org_admin`; any member may remove themselves. Targeting the org owner is `403` for an admin and
  `409 sole_owner` for the owner. `PATCH` with `{}` or the current role records nothing.
- Removing an org member first rejects with `409 sole_owner` (`details[0].workspace_ids`) if they own any workspace
  of the organization, deleted ones included; otherwise every workspace membership in the organization is removed
  as in v1 (`member.removed`, unassignment with the remover as actor, deliveries of deleted workspaces cancelled),
  then `org_member.removed`.
- `PATCH /v1/organizations/{id}`: `name`/`slug` need `org_owner`/`org_admin`, `plan` needs `org_owner`/`billing`,
  both checked before validation; `{}` is allowed to the three of them. A plan change records `plan.changed`;
  `organization.updated` is recorded when `name` or `slug` is present (or the body is empty), with only changed
  fields in `changes`.
- Deleting an organization (`org_owner`, `If-Match` optional) soft-deletes its live workspaces with the v1
  workspace-deletion effects and cancels pending deliveries of its org endpoints; restore brings back exactly the
  workspaces deleted with it (`409 slug_taken` if one slug is now taken). A deleted organization is `410` to its
  members (restore excepted) and `404` to others; a workspace of a deleted organization cannot be restored on its
  own (`410`). Delete and restore each bump `version`.
- Transfer of org ownership: the target must be an org member (`422`, `user_id`, `not_member`); naming the
  current owner is `409 sole_owner`. The previous owner becomes `org_admin`; two `org_member.role_changed` events.
- Deactivating a user who owns an organization is `409 sole_owner` (`details[].organization_ids`); otherwise they
  leave every organization (`org_member.removed`, actor themselves).
- Org activity: `GET /v1/organizations/{id}/activity` for every org role, newest first, with the v1 activity
  filters (`type`, `actor_id`, `target_type` `organization`|`org_member`, `target_id`, `since`, `until`). Creating
  an organization records `organization.created` but no `org_member.added` for the owner.
- Org webhooks (`org_owner`/`org_admin` for every operation, also through `/v1/webhooks/{id}`): `events` is
  `["*"]` or a list of the eight org event types; workspace event names are `invalid_event` because PHASE2 delivers
  workspace events only to `"*"` endpoints. Org event payloads are
  `{delivery_id, event, occurred_at, organization_id, actor, data}` (`data.organization` or `data.member`, plus
  `data.changes` when there are changes). Workspace events reach `"*"` org endpoints with the v1 payload plus
  `organization_id`. One queue per endpoint (as in v1) keeps per-endpoint order across workspaces. Org webhook
  changes record no activity. Webhook objects of org endpoints carry `organization_id` and `workspace_id: null`.
- Workspace objects gain `organization_id`. Digest `data.organizations` lists `{id, name}` of the organizations of
  the overdue and due-today tasks, ordered by id (`[]` when there are none).

### UUIDv7 identifiers (CR-2)

- Migration `003-uuid-ids.sql` renames every table with a public id to `v1_*` and creates it again with `TEXT`
  UUID primary and foreign keys; its post-step (`src/db/steps/uuid-ids-003.ts`) mints the UUIDs, copies the rows,
  rewrites the ids inside stored JSON and drops the `v1_*` tables; `004-uuid-indexes.sql` recreates the indexes. All
  of it runs in the setup transaction, once (`schema_migrations`), so a second `./bin/setup` changes nothing. The
  reference dataset migrates in about 11 s; the file keeps the freed v1 pages until a manual `VACUUM`.
- The integer ids live on in `legacy_ids (kind, legacy_id, uuid)`. The migration timestamp is `meta.ids_migrated_at`:
  the application clock during setup (the test clock override if one is set, otherwise real time).
- Job ids (`/__test/jobs`) and webhook attempt numbers stay integers; CR-2 does not list them. CR-1's frozen
  organization backfill (`src/db/steps/organizations-002.ts`) keeps the integer schema it ran against.
- A new id's timestamp is the application clock at creation (`occurred_at` for events, `created_at` for deliveries,
  `sent_at` for emails). Within one millisecond a process counts up from a random 74-bit start, so ids it mints in
  the same millisecond sort in creation order; ties everywhere use the UUID byte order (lowercase string order).
- Backfilled ids take their timestamp from `created_at` (`occurred_at`, `sent_at`); rows of one table that share a
  millisecond keep their old integer order. An activity target that no longer exists (a deleted webhook) gets a UUID
  timed at the first event that names it.
- Rewritten by the migration: activity and organization event `changes`, delivery payloads, outbox email `data`,
  job payloads, webhook queue keys and idempotency scopes. Left as stored: idempotent response bodies (replayed with
  their integers until they expire) and outbox dedupe keys. The cursor secret is rotated, so every cursor issued
  before the migration is `400 invalid_cursor`.
- Legacy read path: an integer path segment after `users`, `api-keys`, `workspaces`, `organizations`, `members`
  (a user), `projects`, `tasks`, `comments`, `webhooks` or `deliveries`, and an integer in the `actor_id`,
  `assignee_id`, `project_id` or `target_id` filters. `target_id` resolves over every target kind (UUIDs are unique,
  and `target_type` still narrows). An unknown integer is `404` in a path and matches nothing in a filter. The window
  includes the `Sunset` instant (migration + 30 days); after it an integer path or filter is `404 not_found`.
  `Deprecation`/`Sunset` go on every non-error response that resolved a legacy id.
- On a mutating request an integer path id is `404`, decided after authentication, rate limiting and idempotent
  replay (a pre-migration idempotency record still replays its stored body). An integer in any id body field is
  `422 legacy_id_not_allowed`, also after the sunset; a string that is not a UUID is `invalid_format`. UUIDs are
  accepted in any letter case and returned lowercase; a malformed path id is `404`.
- `legacy_ids` is computed when the webhook delivery is created or the email job is enqueued, inside the window. Keys
  are the `*_id` field names, and `<object>_id` for an object's `id` (`task_id`, `actor_id`, `user_id`, …); the first
  occurrence of a key wins and array items (digest task lists) are not included. The field is absent when nothing in
  the document has a legacy id.
- Email dedupe keys embed the UUIDs, including the activity event id.

### Audit log (CR-3)

- Migration `005-audit.sql` adds `audit_entries`, `audit_exports` and `audit_export_chunks`, and rebuilds `jobs` so
  its type check allows `audit_retention` and `audit_export`. No backfill: the log starts empty when a database is
  migrated (earlier history stays in the activity feeds). It runs on fresh and on migrated v1 databases alike.
- Entries are written with the mutation, inside its transaction (`src/audit/record.ts`: `audited` snapshots the
  resource before and after a change, `auditCreated` after a create). The caller comes from a per-request
  `AsyncLocalStorage` context; code outside a request (workers) writes as `actor: {type: "system", id: null,
  name: "system"}` with `ip`, `request_id` and `api_key_id` null. A replayed or rejected request never reaches
  the handler's commit, so it writes nothing.
- Requests authenticated with an API key are recorded as `actor.type: "user"` (the key's user, by name at the
  time) with `api_key_id` the key; `"api_key"` is never used. Registration's entries (the user and its first key)
  name the new user as actor, with `api_key_id` null. `ip` is the client IP (`X-Forwarded-For` with
  `TASKWELL_TRUST_PROXY`).
- `X-Request-Id` (a random UUID) is on every response, not only mutating ones; idempotent replays get a fresh one.
- Resource types: `user`, `api_key`, `organization`, `org_member`, `workspace`, `member`, `project`, `task`,
  `comment`, `webhook`, `delivery`, `email`, `audit_export`. Membership resources use the user id as `resource.id`.
- Snapshots are the API representation: workspaces without the viewer-dependent `my_role`; `member` and
  `org_member` are the list item plus `workspace_id`/`organization_id`; webhooks carry `secret: "[redacted]"`;
  API keys never carry their secret; users add `deactivated_at`; a task's `overdue` uses the actor's timezone (UTC
  for the system). A hard delete (membership, webhook) has `after: null`; a create has `before: null`.
- `diff` compares top-level fields as JSON values and needs both snapshots (`{}` for creates and hard deletes). It
  skips the bookkeeping fields `version` and `updated_at` and fields derived from others: a task's `completed_at`
  and `overdue`, an organization's `limits`, an API key's `last_used_at`.
- Actions: `create`, `update`, `delete`, `restore` as named; `claim` for a task claim; `transfer` on the workspace
  or organization (each also writes `update` entries for the two memberships whose role changed); `revoke` for API
  keys (also each active key at deactivation, followed by the user's `delete`); redelivering a dead delivery is an
  `update` of the delivery. Cascades write one entry per affected resource with the request's `request_id`:
  unassignments, memberships removed by an organization removal or a deactivation, workspaces deleted or restored
  with their organization.
- Not audited: the owner membership created with a workspace or organization (part of its `create`), delivery
  creation, delivery cancellation on workspace or organization deletion, deliveries removed with their webhook,
  `last_used_at`, idempotency/rate-limit/job bookkeeping, the export's completion (its email is), and the
  retention purge.
- Worker entries: one `deliver` per settled attempt (success, failure, timeout, or "worker terminated" on recovery)
  with the delivery as `GET` returns it; one `send` per outbox email actually inserted (a dedupe no-op writes
  nothing). A delivery is scoped by its endpoint (workspace, or organization only); an email by its
  `require_member_of` or `data.workspace_id` workspace and `data.organization_id` or that workspace's organization;
  digests are unscoped.
- Visibility: the workspace audit needs a workspace role of `admin`+ (organization owners and admins read
  workspaces as `viewer`, so they get `403` and use the organization audit) and also works on deleted workspaces;
  the organization audit and stats need `org_owner`/`org_admin`, also on a deleted organization;
  `/v1/users/me/audit` lists entries whose actor is me in workspaces I belong to, at organization level in
  organizations I belong to, or unscoped. `GET /v1/audit/{id}`: workspace entries for workspace `admin`+ or the
  organization's owner/admins, organization entries for its owner/admins, unscoped entries for their actor only;
  `403` when the caller can see the workspace or organization but lacks the role, otherwise `404`.
- Filters: `resource_type` and `action` are enums (`400 invalid_query` otherwise), `actor_id` and `resource_id`
  are ids (legacy integers inside the CR-2 window), `request_id` matches exactly, `since` is inclusive and `until`
  exclusive. Cursors bind to the endpoint and filters as in v1.
- Retention: an `audit_retention` job deletes entries with `occurred_at` before now minus the retention period in
  batches of 2,000 rows, each its own transaction. Outside test mode the scheduler enqueues one at most every
  24 hours; every `POST /__test/scheduler/tick` enqueues one unless one is pending or running.
- Exports: `POST` (idempotent) is `org_owner`/`billing` on a live organization, body `{since, until}` (timestamps,
  `since` < `until`, else `422` on `until` with `invalid_range`), more than 1,000,000 entries in the range at request
  time is `422 export_too_large`; it returns `202` with `{id, organization_id, requested_by, since, until, status:
  "pending", entries: null, created_at, completed_at}` and audits the export's `create`. The `audit_export` job
  writes the organization's entries in the range, `occurred_at` then `id` ascending, as NDJSON chunks of 2,000
  lines; its commit marks the export `ready` and queues `audit_export_ready` (`data: {export_id, organization_id,
  entries, since, until}`, dedupe key `audit_export_ready:<id>`), so a killed and recovered job rewrites the
  chunks and still emails once. `GET .../exports/{id}` (`org_owner`/`billing`) is `409 export_not_ready` while
  pending, otherwise streams `application/x-ndjson`.

### Reference dataset (`POST /__test/seed`)

Deterministic (fixed PRNG seed, except the random bits of the UUIDs), bulk SQL in one transaction, about 9 s: 2,000
users over 60 timezones, 50 workspaces with 20–80 members (owner, about 10 % admins, 75 % members, 15 % viewers),
400 projects (the first has 2,000 tasks), 100,000 tasks (60 % with due dates within ±180 days, 50 % with budgets in
USD/EUR/GBP/JPY/KWD, 15 labels, 70 % assigned), 300,000 comments, one inactive `["*"]` webhook per workspace, and
one activity event per created object. The ten returned users (`seed.user1` … `seed.user10@example.com`) each own
one of the first ten workspaces and are admin, member and viewer in the next three, so every role is represented;
each gets one fresh API key. Each workspace gets its own `business` organization (CR-1), built as the migration
does. Every id is a UUIDv7 timed at the row's `created_at` (CR-2).
