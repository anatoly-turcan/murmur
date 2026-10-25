# Phase 2 change requests (sealed during the experiment)

Handed to teams only after their v1 build has been accepted. Each request is deliberately cross-cutting. Acceptance criteria are black-box over HTTP unless stated otherwise. v1 behaviour that is not mentioned must remain unchanged, and the v1 hidden suite is re-run after each change request.

---

## CR-1: Organizations

### Request

Introduce **organizations** as a new top level above workspaces. Every workspace belongs to exactly one organization. Organizations have their own membership and roles, and carry plan limits that will later drive billing.

### Specification

**Model.** `organization {id, name, slug (globally unique among non-deleted, same rules as workspace slugs), plan: "free" | "team" | "business", limits: {max_workspaces, max_members_per_workspace, max_webhooks_per_workspace, api_requests_per_minute}, owner_id, version, created_at, updated_at, deleted_at}`. Plan defaults: free `{3, 10, 2, 300}`, team `{20, 100, 10, 1200}`, business `{unlimited (null), unlimited, 50, 6000}`.

**Org roles.** `org_owner`, `org_admin`, `billing`, `org_member`. Table:

| Action | org_owner | org_admin | billing | org_member |
|---|:-:|:-:|:-:|:-:|
| Read organization, its member list, its workspace list | ✔ | ✔ | ✔ | ✔ |
| Create workspace in the org | ✔ | ✔ | – | ✔ |
| Read any workspace of the org (as if `viewer`) without being a workspace member | ✔ | ✔ | – | – |
| Add/remove org members, change roles below `org_owner` | ✔ | ✔ | – | – |
| Change plan, read usage | ✔ | – | ✔ | – |
| Delete/restore organization, transfer org ownership | ✔ | – | – | – |

A workspace owner must be an org member. Removing a user from the organization removes them from all of its workspaces (with the v1 consequences of removal, including unassignment); if they own a workspace, the removal is rejected with `409 sole_owner` listing the workspace ids.

**Endpoints.** `POST/GET /v1/organizations`, `GET/PATCH/DELETE /v1/organizations/{id}`, `POST .../restore`, `POST .../transfer-ownership`, `GET/POST /v1/organizations/{id}/members`, `PATCH/DELETE .../members/{user_id}`, `GET /v1/organizations/{id}/workspaces`, `GET /v1/organizations/{id}/usage` → `{"workspaces": n, "members": n, "api_requests_last_minute": n, "limits": {...}}`. `POST /v1/workspaces` now requires `organization_id` in the body. All list endpoints follow v1 pagination; all new creates are idempotent; all new versioned objects use `If-Match`.

**Limits.** Creating a workspace beyond `max_workspaces`, adding a member beyond `max_members_per_workspace`, or adding a webhook beyond `max_webhooks_per_workspace` → `422` with detail code `plan_limit_exceeded` and `details[0].limit`. `api_requests_per_minute` is a new rate-limit bucket keyed by organization, applied to every workspace-scoped request, in addition to the v1 buckets; `RateLimit-*` headers keep reporting the most constrained bucket. Lowering a plan never deletes anything; it only prevents further growth.

**Migration.** Every existing workspace must be migrated into a new organization named after the workspace, owned by the workspace owner, on the `free` plan, with every workspace member as `org_member`. Existing data above the free limits remains intact. The migration runs as part of `./bin/setup` and must be idempotent.

**Activity and webhooks.** New event types `organization.created/updated/deleted/restored`, `org_member.added/removed/role_changed`, `plan.changed` appear in a new `GET /v1/organizations/{id}/activity` feed. Workspace activity is unchanged. Org-level webhook endpoints (`/v1/organizations/{id}/webhooks`) receive org events plus, when subscribed with `"*"`, all events of all workspaces of the org, with per-endpoint ordering preserved across workspaces. Digest emails gain `data.organizations: [{"id","name"}]` for the organizations whose tasks appear.

### Acceptance criteria

1. After `./bin/setup` on a v1 database with 3 workspaces owned by two users, `GET /v1/organizations` as each user lists exactly the orgs for the workspaces they owned; each org has `plan: "free"` and the workspace members as `org_member`.
2. A `free` org with 3 workspaces rejects a 4th with `422 plan_limit_exceeded`, `details[0].limit: 3`; after `PATCH` to `team` by the `billing` role, the 4th succeeds.
3. An `org_admin` who is not a member of workspace W can `GET` W's tasks and search W, but receives `403` on `PATCH` of a task in W.
4. Removing user U from the org while U is a `member` of two workspaces makes U's next request to either workspace return `404`, and U's assigned tasks in both show `assignee_id: null` with `task.updated` events authored by the remover.
5. Removing U while U owns a workspace returns `409 sole_owner` listing that workspace id, and nothing changes.
6. With `api_requests_per_minute: 300`, 301 workspace-scoped requests by different keys in the same org within one clock minute yield exactly one `429`, with `Retry-After` and `RateLimit-Limit: 300`.
7. An org webhook subscribed with `"*"` receives events from two different workspaces of the org in global creation order, serialized through one in-flight delivery at a time.
8. All v1 hidden tests still pass, with `organization_id` added to workspace creation calls.

---

## CR-2: UUIDv7 public identifiers

### Request

Replace all public integer identifiers (users, API keys, workspaces, projects, tasks, comments, activity events, webhooks, deliveries, emails, organizations) with UUIDv7 strings. Old integer identifiers must continue to work on read for 30 days after the migration date, after which they return `404`.

### Specification

* Every `id` and every `*_id` field in responses, webhook payloads, email `data`, activity `target.id` and cursors becomes a lowercase RFC 9562 UUIDv7 string. New objects get a UUIDv7 generated at creation time whose timestamp component equals the application clock at creation.
* Existing rows receive a UUIDv7 whose timestamp component is derived from the row's `created_at`. Migration is part of `./bin/setup`, idempotent, and must handle the reference dataset within 10 minutes.
* **Legacy read path.** For 30 days from the migration timestamp (recorded in the database, measured on the application clock), any path segment or filter value that is a plain integer is resolved through the legacy mapping and served normally; the response body contains only UUIDs. Responses served through a legacy id carry `Deprecation: true` and `Sunset: <HTTP-date 30 days after migration>` headers. After the sunset instant, integer ids return `404 not_found`.
* Legacy ids are accepted only on `GET` requests and in `GET` filter parameters. On any mutating request, an integer id in the path returns `404`; an integer in an `*_id` body field returns `422` with detail code `legacy_id_not_allowed`.
* Webhook payloads and email `data` emitted after migration use UUIDs and additionally include `legacy_ids: {"task_id": 42, ...}` for objects that have one, for the same 30 days, then drop the field.
* Idempotency replays of requests stored before migration return the stored body unchanged (integers), with `Idempotent-Replayed: true`, until their natural 24-hour expiry.
* Cursors issued before migration are rejected with `400 invalid_cursor` after it.
* Ordering rules that used `id` as tie-breaker now use the UUID's byte order, which is time-ordered for UUIDv7; the ordering of objects created in the same millisecond must still be deterministic and stable across pages.

### Acceptance criteria

1. On a migrated v1 database, `GET /v1/tasks/42` returns the task with a UUID `id`, `Deprecation: true` and a `Sunset` header exactly 30 days after the migration timestamp; `GET /v1/tasks/<that uuid>` returns the identical body without those headers.
2. `PATCH /v1/tasks/42` returns `404`; `PATCH /v1/tasks/<uuid>` with body `{"assignee_id": 7}` returns `422` with `legacy_id_not_allowed`, while `{"assignee_id": "<user uuid>"}` succeeds.
3. After `PUT /__test/clock` to 30 days + 1 second past migration, `GET /v1/tasks/42` returns `404` and `GET /v1/tasks/<uuid>` still works.
4. Two tasks created with the clock frozen (same millisecond) appear in deterministic order in `GET .../tasks?sort=created_at` and are not duplicated or skipped across a page boundary of `limit=1`.
5. A webhook payload for a task created after migration contains `data.task.id` as a UUID and `legacy_ids` absent (new object); one for an edit of a migrated task contains `legacy_ids.task_id` equal to its old integer.
6. `GET /v1/workspaces/<uuid>/tasks?assignee_id=5` (legacy integer in a filter) works during the window and returns `Deprecation: true`.
7. All v1 hidden tests pass with ids treated as opaque strings.

---

## CR-3: Audit log

### Request

Record an immutable audit entry for every mutation in the system, including mutations performed by the worker, and expose it with the same pagination and permission model as the rest of the API, with configurable retention.

### Specification

**Entry.** `{id, occurred_at, actor: {type: "user"|"system"|"api_key", id, name} , api_key_id, ip, request_id, organization_id, workspace_id, resource: {type, id}, action: "create"|"update"|"delete"|"restore"|"transfer"|"revoke"|"claim"|"deliver"|"send", before: {...} | null, after: {...} | null, diff: {field: {from, to}}, idempotent_replay: false}`.

* `before`/`after` are full snapshots of the public representation of the resource (as `GET` would return it to an admin), with `secret` fields redacted to `"[redacted]"`. `diff` lists only changed fields; array and object fields are compared as whole values.
* Entries are written in the same transaction as the mutation. An idempotent replay writes no entry. A request rejected with any 4xx writes no entry. A `PATCH` with `{}` writes an entry with an empty `diff` and `version` change only.
* Worker-originated mutations (unassignment during removal is user-originated; webhook delivery state changes and email sends are worker-originated) use `actor.type: "system"` with `action` `deliver` or `send`, and `after` containing the delivery or email record.
* Member removal that unassigns tasks produces one entry per task plus one for the membership, sharing the same `request_id`.
* Every API response to a mutating request carries `X-Request-Id`; the audit entries it produced carry that value.

**Endpoints.**
`GET /v1/workspaces/{id}/audit` (admin+), `GET /v1/organizations/{id}/audit` (org_admin+; covers all workspaces of the org and org-level mutations), `GET /v1/users/me/audit` (the requester's own actions across all workspaces they are still a member of). Ordering `occurred_at desc, id desc`. Filters: `actor_id`, `resource_type`, `resource_id`, `action`, `since`, `until`, `request_id`; all combinable with cursors under v1 cursor-binding rules. `GET /v1/audit/{id}` with the same visibility rule as the resource's workspace. Audit entries for a workspace remain visible to admins after the workspace is soft-deleted and after the resource is deleted; they are never visible to users who are no longer members.

**Retention.** `TASKWELL_AUDIT_RETENTION_DAYS` (default 365). A worker job running daily (and on `POST /__test/scheduler/tick`) permanently deletes entries older than the retention period, on the application clock, in batches that keep every other targets of section 14.2 within limits. Deleting is itself not audited. `GET /v1/organizations/{id}/audit/stats` → `{"entries": n, "oldest": ts, "retention_days": 365}`.

**Export.** `POST /v1/organizations/{id}/audit/exports` (org_owner, billing) with `{since, until}` enqueues a job that writes newline-delimited JSON to the outbox-like **exports** table and emails the requester an `audit_export_ready` message with `data.export_id`; `GET /v1/organizations/{id}/audit/exports/{export_id}` streams the file (`application/x-ndjson`). An export covering more than 1,000,000 entries is rejected with `422 export_too_large`.

### Acceptance criteria

1. A `PATCH` of a task's `status` and `labels` yields exactly one entry with `action: "update"`, `diff` containing exactly those two fields with correct `from`/`to`, `before.version = after.version - 1`, and `request_id` equal to the response's `X-Request-Id`.
2. Replaying that `PATCH`'s sibling idempotent `POST` (same key, same body) adds no entry; a `409 version_conflict` adds no entry.
3. Removing a member assigned to three tasks yields four entries sharing one `request_id`; `?request_id=` returns exactly those four.
4. A viewer gets `403` on the workspace audit; a removed member gets `404`; an admin can still read the entries of a task that has since been soft-deleted and of a workspace that has since been soft-deleted.
5. A webhook delivery that succeeds on its second attempt produces two `deliver` entries with `actor.type: "system"` and `after.attempts` of length 1 and 2 respectively; the webhook's `secret` never appears in any entry (`[redacted]`).
6. With `TASKWELL_AUDIT_RETENTION_DAYS=30`, after advancing the clock 31 days and ticking the scheduler, entries created before the advance are gone from every audit endpoint, `stats.entries` reflects it, and entries created after remain.
7. Paging through 250 entries with `limit=100` while new mutations occur returns each pre-existing entry exactly once.
8. Export of a 10,000-entry range produces an `audit_export_ready` email exactly once (also when the worker is killed mid-export and restarted) and a downloadable NDJSON file with 10,000 lines.
9. All v1 and CR-1/CR-2 hidden tests still pass; p99 of task `POST`/`PATCH` stays within the v1 150 ms target with audit writing enabled.
