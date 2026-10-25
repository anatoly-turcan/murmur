# Taskwell — Team Task Tracker API

## Product specification, v1.0

Taskwell is a multi-user task tracker for small and medium teams, exposed exclusively as an HTTP JSON API. There is no user interface. Customers integrate it into their own tools; the API is the product.

This document is the complete contract for v1. Anything not described here is an implementation choice; document notable ones in the README (section 15).

---

## 1. Product overview

A **user** registers with an email address, a display name and an IANA timezone, and authenticates with API keys. Users create **workspaces** and invite other users as **members** with one of four roles (owner, admin, member, viewer). A workspace contains **projects**; a project contains **tasks**. Tasks have a status, at most one assignee, free-form labels, an optional due date, an optional time estimate and an optional money budget. Members discuss tasks in **comments**. Every change in a workspace is recorded in an **activity feed**, can be pushed to the workspace's **webhook endpoints**, and may trigger an **email notification**. Each user receives a **daily digest** email at 08:00 in their own timezone. A **search** endpoint finds tasks by text across titles, descriptions and comments.

Deletions are soft and reversible, except for API keys (which are revoked) and webhook endpoints (which are removed permanently). All lists are cursor-paginated. Creation endpoints are idempotent through an `Idempotency-Key` header. Edits are protected by optimistic concurrency. Everything asynchronous (webhook delivery, emails, digests, reminders) is carried out by the **worker**, started separately with `./bin/worker`; `/v1` requests never wait for it.

The system must run on a single machine against one relational database. `./bin/api` may use any number of OS processes or threads; `./bin/worker` may be run as one or two instances. The database is the only shared infrastructure; no other server such as a cache or a message broker may be required. The database is SQLite, PostgreSQL, or both; the README lists those supported.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| Actor | The user whose API key authenticated a request. |
| Application clock | The current time as the system sees it. It is real time, unless a test clock override is active (section 13.4). Every time-dependent rule in this document uses the application clock, except the per-operation timeouts listed at the end of 13.4. |
| Deleted (soft-deleted) | An object whose `deleted_at` is set. It is hidden from lists and search, returns `410` on direct access, and can be restored. |
| Local date / local time | A date or time expressed in a specific user's IANA timezone. |
| Member | A user who has a membership (any role) in a workspace. |
| Minor unit | The smallest unit of a currency (cents for USD, yen for JPY, fils for KWD). |
| Reference dataset | The dataset described in section 14.1, used for performance targets. |
| Scheduler | The evaluation of time-based rules (digests, reminders), run once per minute outside test mode. |
| Workspace-scoped request | A request whose target object belongs to a workspace (anything under `/workspaces/{id}/...`, or a project, task, comment, webhook or delivery that belongs to a workspace). |

---

## 3. Domain model and invariants

All public identifiers are positive integers not exceeding 2^53−1, serialised as JSON numbers. All `*_at` fields are UTC timestamps (section 6.9). All text fields are stored after Unicode NFC normalisation and with leading/trailing whitespace trimmed. Character limits count Unicode code points after normalisation.

### 3.1 User

| Field | Type | Notes |
|---|---|---|
| `id` | integer | |
| `email` | string | ≤ 254 chars, exactly one `@` with non-empty text on both sides. Unique among non-deactivated users, compared case-insensitively. A deactivated user's email may be registered again. |
| `name` | string | 1–100 chars. |
| `timezone` | string | Any Zone or Link name of the IANA time zone database, release 2024a or later, such as `Europe/Athens`. Default `UTC`. |
| `digest_enabled` | boolean | Default `true`. |
| `created_at`, `updated_at` | timestamp | |
| `deactivated_at` | timestamp or null | |

### 3.2 API key

| Field | Type | Notes |
|---|---|---|
| `id` | integer | |
| `name` | string | 1–100 chars. |
| `prefix` | string | First 12 characters of the secret, for identification. |
| `secret` | string | `twl_` followed by 40 characters from `[A-Za-z0-9]`. Returned once, at creation. Only a hash is stored. |
| `created_at`, `last_used_at`, `revoked_at` | timestamp or null | |

### 3.3 Workspace

| Field | Type | Notes |
|---|---|---|
| `id` | integer | |
| `name` | string | 1–100 chars. |
| `slug` | string | 1–50 chars consisting of lowercase or caseless letters of any script (no uppercase or titlecase letters), digits and hyphens; no leading, trailing or consecutive hyphens (otherwise `422 invalid_format` at `slug`). Unique among non-deleted workspaces, where two slugs are equal if they are equal after NFKC normalisation and case folding. If omitted at creation, derived from the name: case-folded, every run of characters that are not letters or digits replaced by one hyphen, hyphens trimmed from both ends, cut to 50 chars and re-trimmed; if the result is empty, `workspace` is used; if taken, the first free numeric suffix `-2`, `-3`, … is appended, cutting the base so that base plus suffix fit in 50 chars and re-trimming hyphens. Projects derive their slug the same way, with fallback `project`. |
| `owner_id` | integer | Exactly one owner at all times. |
| `version` | integer | Starts at 1. |
| `my_role` | string (read-only) | The requester's role in the workspace. |
| `created_at`, `updated_at`, `deleted_at` | | |

### 3.4 Membership

A (workspace, user) pair with a `role` in `owner | admin | member | viewer` and a `joined_at`. A user has at most one membership per workspace. The workspace owner always has the `owner` role and is the only user with that role.

### 3.5 Project

| Field | Type | Notes |
|---|---|---|
| `id`, `workspace_id` | integer | |
| `name` | string | 1–100 chars. |
| `slug` | string | Same rules and equality as workspace slug. Unique among non-deleted projects of the same workspace. A slug that breaks these rules → `422 invalid_format` at `slug`. |
| `description` | string or null | ≤ 5,000 chars. |
| `creator_id` | integer | |
| `version` | integer | |
| `created_at`, `updated_at`, `deleted_at` | | |

### 3.6 Task

| Field | Type | Notes |
|---|---|---|
| `id`, `project_id`, `workspace_id` | integer | |
| `title` | string | 1–200 chars. |
| `description` | string or null | ≤ 20,000 chars. |
| `status` | enum | `open`, `in_progress`, `done`. Default `open`. |
| `labels` | array of strings | 0–20 items, each 1–40 chars. Two labels that are equal after NFKC normalisation and case folding are duplicates, and a request containing duplicates is rejected. |
| `assignee_id` | integer or null | A task has at most one assignee at any moment. The assignee must be a current member of the task's workspace with role `member`, `admin` or `owner`. |
| `creator_id` | integer | |
| `due_date` | date (`YYYY-MM-DD`) or null | A calendar date without timezone. |
| `overdue` | boolean (read-only) | `true` when `status` is not `done`, `due_date` is set, and `due_date` is earlier than the current local date in the requesting user's timezone. |
| `estimate_minutes` | integer or null | 0–100,000. |
| `budget` | money or null | See 3.7. |
| `version` | integer | |
| `completed_at` | timestamp or null | Set when status becomes `done`, cleared when it leaves `done`. |
| `created_at`, `updated_at`, `deleted_at` | | |

### 3.7 Money

A money value is an object `{"currency": "USD", "amount": "120.50", "amount_minor": "12050"}`. On input only `currency` and `amount` are accepted, and always together; `amount` is a JSON **string** of decimal digits with an optional fractional part (`^[0-9]{1,15}(\.[0-9]{1,6})?$`), never a JSON number. On output all three fields are returned; `amount` is formatted with exactly the currency's number of decimals and `amount_minor` (like every `*_minor` field) is a string of decimal digits.

Supported currencies and decimals: `USD` 2, `EUR` 2, `GBP` 2, `CHF` 2, `SEK` 2, `PLN` 2, `JPY` 0, `KRW` 0, `KWD` 3, `BHD` 3. An amount with more fractional digits than its currency allows is a validation error (`too_many_decimals`); an amount that does not match the pattern fails with `invalid_format` alone, even if it also has too many decimals. Amounts are stored as integers in minor units. Aggregations (7.5, project summary) are computed on minor units and rounded half away from zero to the currency's decimals. Aggregates are exact regardless of size.

### 3.8 Comment

| Field | Type | Notes |
|---|---|---|
| `id`, `task_id`, `workspace_id` | integer | |
| `author` | object | `{"id", "name", "deleted"}`. When the author has been deactivated, `name` is `"Deleted user"` and `deleted` is `true`. |
| `body` | string | 1–10,000 chars. |
| `edited` | boolean | `true` once the body has been changed. |
| `version` | integer | |
| `created_at`, `updated_at`, `deleted_at` | | |

### 3.9 Activity event

Immutable. `{"id", "workspace_id", "type", "actor": {"id","name","deleted"}, "target": {"type": "task", "id": 42}, "changes": {"status": {"from": "open", "to": "done"}}, "occurred_at"}`. `changes` is `{}` for events that are not field edits. For `member.*` and `ownership.transferred` events, `target` is `{"type": "member", "id": <user id>}`. Types: `workspace.created`, `workspace.updated`, `workspace.deleted`, `workspace.restored`, `member.added`, `member.role_changed`, `member.removed`, `ownership.transferred`, `project.created`, `project.updated`, `project.deleted`, `project.restored`, `task.created`, `task.updated`, `task.deleted`, `task.restored`, `comment.created`, `comment.updated`, `comment.deleted`, `comment.restored`, `webhook.created`, `webhook.updated`, `webhook.deleted`.

### 3.10 Webhook endpoint and delivery

See section 8.

### 3.11 Invariants

These invariants hold at all times, under any number of concurrent requests and with up to two worker instances.

1. Exactly one owner per workspace.
2. At most one assignee per task, and on every non-deleted task the assignee is a current, assignable member of the task's workspace.
3. No two non-deleted workspaces share a slug; no two non-deleted projects of the same workspace share a slug.
4. No two non-deactivated users share an email (case-insensitive).
5. `version` increases by exactly one on every change to a versioned object (workspace, project, task, comment), whether requested directly or caused by another operation (status changes, claims, soft deletion, restores, unassignment on removal, ownership transfer).
6. Every successful mutating request produces the activity events specified for it, and no others.

---

## 4. Authentication

Every request except `POST /v1/users`, `GET /healthz` and the `/__test/*` endpoints requires the header:

```
Authorization: Bearer twl_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

* Missing or malformed header → `401 unauthenticated`.
* Unknown key, revoked key, or key of a deactivated user → `401 invalid_api_key`.
* Revocation and deactivation take effect as soon as the revoking request returns.
* Any `Authorization` value not matching `Bearer twl_[A-Za-z0-9]{40}` is malformed.
* `last_used_at` of a key is updated at least once per minute of use.

Registering (`POST /v1/users`) returns the user together with a first API key. Users may hold up to 20 active keys.

---

## 5. Authorization

### 5.1 Visibility rule

A user can see a workspace-scoped object only while they hold a membership in that workspace. A request from a non-member for any object in a workspace, including an object the user created or previously had access to, returns `404 not_found`, indistinguishable from a nonexistent object. Losing membership (removal, leaving, deactivation) is effective immediately, including for existing tasks and comments.

A request from a member whose role is insufficient returns `403 forbidden`.

### 5.2 Permission table

| Action | Owner | Admin | Member | Viewer |
|---|:-:|:-:|:-:|:-:|
| Read workspace, members, projects, tasks, comments, activity, summary, search | ✔ | ✔ | ✔ | ✔ |
| Update workspace name/slug | ✔ | ✔ | – | – |
| Delete / restore workspace | ✔ | – | – | – |
| Transfer ownership | ✔ | – | – | – |
| Add member with role `member` or `viewer`; change roles among `member`/`viewer`; remove members with those roles | ✔ | ✔ | – | – |
| Add / promote / demote / remove an `admin` | ✔ | – | – | – |
| Leave the workspace | – (must transfer first) | ✔ | ✔ | ✔ |
| Create project; update project | ✔ | ✔ | ✔ | – |
| Delete / restore project | ✔ | ✔ | – | – |
| Create task; update any task field; claim | ✔ | ✔ | ✔ | – |
| Delete / restore task | ✔ | ✔ | creator or assignee only | – |
| Be assigned a task | ✔ | ✔ | ✔ | – |
| Create comment | ✔ | ✔ | ✔ | – |
| Edit comment | author only | author only | author only | – |
| Delete / restore comment | ✔ | ✔ | author only | – |
| Create / update / delete webhooks; read deliveries; redeliver | ✔ | ✔ | – | – |

Additional rules:

* The owner cannot be removed, demoted or made to leave. Ownership is changed only with `POST /v1/workspaces/{id}/transfer-ownership`, which makes the target (who must already be a member of any role) the owner and the previous owner an admin, in one atomic step.
* Removing a member clears `assignee_id` on every non-deleted task in that workspace assigned to them, each producing a `task.updated` activity event with the remover as actor.
* A user cannot deactivate their account while they own any workspace, deleted or not.

---

## 6. API conventions

### 6.1 General

* Base path `/v1`. Request and response bodies are JSON (`Content-Type: application/json`, parameters such as `charset` allowed). A request that carries a body with another media type → `415 unsupported_media_type`; requests without a body need no `Content-Type`. A body larger than 64 KiB → `413 payload_too_large`. A body that is valid JSON but not an object → `422 invalid_type` at the empty path.
* Unknown fields in a request body are rejected (`422`, detail code `unknown_field`). Unknown query parameters, and query parameter values outside their documented type or set (an unknown `status` or `type` value, `overdue=maybe`, a non-date `due_after`, a non-integer id), → `400 invalid_query`.
* Responses that carry no body use `204 No Content`.
* Every successful response that returns a single versioned object (create with `201`, `GET`, `PATCH`, claim, restore, transfer) includes `ETag: "<version>"`.

### 6.2 Error format

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request body is invalid.",
    "details": [
      {"path": "budget.amount", "code": "too_many_decimals", "message": "JPY amounts have no decimals."},
      {"path": "labels[2]", "code": "too_long", "message": "Must be at most 40 characters."}
    ]
  }
}
```

`details` is present only when it carries information. A detail always has `path` and `code` and may carry additional keys. `path` uses dot notation for object fields and `[n]` for array indexes; an empty `path` refers to the body as a whole.

### 6.3 Status codes

| Status | When | Top-level `code` |
|---|---|---|
| 400 | Request cannot be understood: unparsable JSON, invalid query parameter type or value (`limit=abc`, `limit=500`), invalid or mismatched cursor, malformed header value | `malformed_json`, `invalid_query`, `invalid_cursor`, `cursor_mismatched`, `invalid_header` |
| 401 | See section 4 | `unauthenticated`, `invalid_api_key` |
| 403 | Authenticated member, insufficient role | `forbidden` |
| 404 | Object does not exist, or requester is not a member of its workspace | `not_found` |
| 405 | Method not supported on path | `method_not_allowed` |
| 409 | Request is well-formed and valid but conflicts with current state | `version_conflict`, `slug_taken`, `email_taken`, `already_assigned`, `already_member`, `sole_owner`, `not_deleted`, `not_redeliverable`, `idempotency_in_progress` |
| 410 | Object is soft-deleted (or belongs to a soft-deleted parent) and the requester would otherwise be allowed to see it; also every list, summary or creation endpoint nested under a soft-deleted object (for example the tasks list or summary of a deleted project, the comments of a deleted task) | `gone` |
| 413 | Body over 64 KiB | `payload_too_large` |
| 415 | Wrong media type | `unsupported_media_type` |
| 422 | Body is well-formed JSON but a field is semantically invalid; or `Idempotency-Key` reuse with a different request | `validation_failed`, `idempotency_key_reused` |
| 429 | Rate limit exceeded | `rate_limited` |
| 500 | Unexpected failure | `internal_error` |
| 503 | Database unreachable (`GET /healthz` only) | `database_unavailable` |
| 400 / 409 (test endpoints) | Clock not overridden; database not empty when seeding | `clock_not_overridden`, `database_not_empty` |

Precedence when several apply: 429 → 401 → 404 (visibility) → 410 → 403 → 400/413/415 → 422 → 409. Restore endpoints act on deleted objects, so the deleted state of the object being restored never yields `410`, and the role check (`403`) comes right after visibility.

Throughout this document, the shorthand `422 x` means a `422 validation_failed` response with one detail of code `x` at the named path; `409 x` and `400 x` name the top-level `code`.

Detail codes used within `validation_failed`: `required`, `invalid_type`, `too_short`, `too_long`, `out_of_range`, `invalid_enum`, `invalid_format`, `invalid_timezone`, `invalid_date`, `not_nullable`, `unknown_field`, `duplicate`, `too_many_items`, `unsupported_currency`, `too_many_decimals`, `user_not_found`, `not_member`, `not_assignable`, `invalid_project`, `invalid_url`, `invalid_event`.

### 6.4 Pagination

Every list endpoint under `/v1` accepts `limit` (integer 1–100, default 20) and `cursor` (opaque string). Responses have the shape:

```json
{"data": [ ... ], "next_cursor": "c_9QzR2mT7vKf1Lp"}
```

`next_cursor` is `null` when there are no more items. Cursors are opaque to clients. Each list endpoint defines a total ordering with `id` (for members, `user_id`) as the final tie-breaker; the ordering is the one documented for the endpoint and does not change between pages. A cursor is bound to the endpoint and to the filter, sort and `include_deleted` parameters of the request that produced it: a request that sends a cursor together with different filter, sort or `include_deleted` values is rejected with `400 invalid_cursor`, as is a cursor that cannot be decoded; a cursor presented to a different list endpoint is rejected with `400 cursor_mismatched`.

Paging is stable: an item that exists for the whole duration of a paging session and is not modified appears exactly once across the pages, and items created, modified or deleted between page fetches never cause another item to be repeated or skipped.

### 6.5 Idempotent creation

All `POST` endpoints that create an object (users, API keys, workspaces, members, projects, tasks, comments, webhooks) accept an optional `Idempotency-Key` header (1–255 printable ASCII characters; any other value → `400 invalid_header`). Keys are scoped to the authenticated user (to the client IP for `POST /v1/users`) and are remembered for 24 hours on the application clock; after that a key is treated as never used. On `POST` endpoints that do not create an object (claim, restore, transfer-ownership, redeliver) the header is not read at all, so any value there is accepted without effect.

* First request with a key: processed normally. If it succeeds with a 2xx, the status, headers and body are stored under the key, together with a fingerprint of the request body.
* Repeat with the same key and an identical body (compared as parsed JSON, so key order and whitespace do not matter): the stored response is returned unchanged, with the additional header `Idempotent-Replayed: true`. No new object is created and no new activity, webhook or email is produced.
* Repeat with the same key and a different body: `422 idempotency_key_reused`.
* Repeat while the first request is still being processed: `409 idempotency_in_progress`.
* A first request that failed (4xx/5xx) does not consume the key.

### 6.6 Optimistic concurrency

`PATCH` and `DELETE` on workspaces, projects, tasks and comments accept an optional `If-Match: "<version>"` header. On every other endpoint, including claim, restore and transfer-ownership, the header is not read at all and has no effect. If the header is present and does not equal the object's current version, the request is rejected with `409 version_conflict` and `details: [{"path": "version", "code": "stale", "current_version": 7}]`, and nothing is changed. Without the header the write is unconditional. The only accepted form is a quoted decimal integer such as `"7"`; anything else (unquoted, weak `W/` prefix, `*`, several values) → `400 invalid_header`.

### 6.7 Partial updates

`PATCH` bodies contain only the fields to change. A field that is **absent** is left unchanged. A field that is present with the value **`null`** is cleared, which is allowed only for nullable fields (`description`, `assignee_id`, `due_date`, `estimate_minutes`, `budget`); `null` for a non-nullable field is a `422` with detail code `not_nullable`. An empty body `{}` is a valid request that changes nothing except `version` and `updated_at`; it still produces the object's `*.updated` activity event with `changes: {}` and the corresponding webhook deliveries. `budget` is always given complete (`currency` and `amount`) or `null`.

### 6.8 Rate limiting

Limits are counted in fixed one-minute windows aligned to the application clock (a window starts at `:00` seconds). Each request is counted in every bucket that applies to it; a request is rejected if any bucket is exhausted. Only `429` responses are not counted. Requests answered `401` count against the unauthenticated IP bucket, and once that bucket is exhausted such requests receive `429`. A workspace-scoped request from a non-member counts in the "Key, general" bucket.

| Bucket | Applies to | Limit per minute |
|---|---|---|
| IP, unauthenticated | requests without a valid key | 30 |
| IP, authenticated | all requests with a valid key | 1,200 |
| Key, general | requests that are not workspace-scoped, and workspace-scoped requests from non-members | 120 |
| Key + workspace, by role | workspace-scoped requests, according to the requester's role in that workspace | owner/admin 600, member 300, viewer 60 |

Every response, including rejections, carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (whole seconds until the window ends), describing the bucket with the fewest remaining requests. A `429` additionally carries `Retry-After` (whole seconds). `GET /healthz` and `/__test/*` are exempt.

The client IP is the socket peer address, unless `TASKWELL_TRUST_PROXY=true`, in which case it is the first value of `X-Forwarded-For`.

### 6.9 Timestamps and dates

All timestamps are returned in UTC as ISO-8601 with millisecond precision and a `Z` suffix: `2026-03-08T13:00:00.000Z`. Timestamps accepted as input may carry any offset and are normalised to UTC. Dates are `YYYY-MM-DD` and have no timezone. Durations in request bodies are integers in the named unit.

### 6.10 Text handling

All incoming strings are NFC-normalised and trimmed (leading and trailing characters with the Unicode `White_Space` property removed) before validation and storage; a string that is empty after trimming fails its minimum length with `too_short` (`required` is used only for absent fields). Comparisons for uniqueness (slugs, emails, labels) and for search use NFKC normalisation followed by Unicode case folding. Case folding is full case folding (statuses C and F of the Unicode CaseFolding data), Unicode 15.0 or later. Canonically equivalent spellings are therefore the same slug and match the same searches.

---

## 7. Endpoints

Request examples omit the `Authorization` header. Response examples omit fields that are self-evident from the domain model unless they illustrate a rule.

### 7.1 Health

`GET /healthz` → `200 {"status": "ok", "database": "ok"}`. Returns `503 database_unavailable` (standard error format) if the database cannot be reached. No authentication, no rate limit.

### 7.2 Users and API keys

#### `POST /v1/users` — register

No authentication. Idempotent.

```json
{"email": "ana@example.com", "name": "Ana", "timezone": "Europe/Athens"}
```

`201`:

```json
{
  "user": {"id": 1, "email": "ana@example.com", "name": "Ana", "timezone": "Europe/Athens",
           "digest_enabled": true, "created_at": "2026-03-01T09:00:00.000Z", "updated_at": "2026-03-01T09:00:00.000Z"},
  "api_key": {"id": 1, "name": "default", "prefix": "twl_k3Jd9sQp", "secret": "twl_k3Jd9sQp…", "created_at": "2026-03-01T09:00:00.000Z"}
}
```

Errors: `409 email_taken`; `422` for invalid email, name or timezone (`invalid_timezone`). `timezone` defaults to `UTC` when omitted.

#### `GET /v1/users/me` → `200` user object.

#### `PATCH /v1/users/me`

Fields: `name`, `timezone`, `digest_enabled`. `200` user object. Changing `timezone` affects digest, reminder and `overdue` computations from the next evaluation onward.

#### `DELETE /v1/users/me` — deactivate

`204`. Revokes all API keys, removes all memberships (with the same consequences as removal by an admin, actor being the user), keeps the user's comments and activity visible with the author shown as `{"id": <id>, "name": "Deleted user", "deleted": true}`. `409 sole_owner` with `details: [{"path": "workspaces", "code": "sole_owner", "workspace_ids": [3, 9]}]` if the user owns any workspace, deleted or not.

#### `GET /v1/users/{id}`

`200 {"id", "name", "created_at"}` for a user who shares at least one non-deleted workspace with the requester, or is the requester. Otherwise `404`.

#### `GET /v1/users/me/api-keys`

List, ordered `created_at asc, id asc`, revoked keys included with `revoked_at` set. Items never contain `secret`.

#### `POST /v1/users/me/api-keys` — `{"name": "ci"}` → `201` key with `secret`. Idempotent. A 21st active key → `422` with detail code `too_many_items` and an empty `path`.

#### `DELETE /v1/users/me/api-keys/{id}` → `204`; revoking the key used for the request is allowed and the response is still `204`. Already revoked → `204`. Another user's key → `404`.

### 7.3 Workspaces

#### `POST /v1/workspaces` — `{"name": "Acme Ops", "slug": "acme-ops"}` → `201` workspace. Idempotent.

The creator becomes owner. `409 slug_taken` if a given slug is in use by a non-deleted workspace; a derived slug that is taken gets the first free numeric suffix (3.3).

```json
{"id": 3, "name": "Acme Ops", "slug": "acme-ops", "owner_id": 1, "version": 1,
 "created_at": "…", "updated_at": "…", "deleted_at": null, "my_role": "owner"}
```

#### `GET /v1/workspaces` — workspaces the requester is a member of, non-deleted. Ordered `id asc`. Each item carries `my_role`. `include_deleted=true` additionally returns deleted workspaces the requester owns.

#### `GET /v1/workspaces/{id}` → `200` with `ETag`. `410 gone` if deleted (members only; non-members `404`).

#### `PATCH /v1/workspaces/{id}` — `name`, `slug`. Admin+. `If-Match` honoured.

#### `DELETE /v1/workspaces/{id}` — owner. `204`. Everything inside becomes inaccessible (`410`), is excluded from all lists and search, stops producing digests and reminders, and pending webhook deliveries of its endpoints are cancelled.

#### `POST /v1/workspaces/{id}/restore` — owner. `200` workspace. `409 not_deleted` if not deleted; `409 slug_taken` if the slug was taken meanwhile. Projects, tasks and comments that were visible at deletion time become visible again; objects that had been individually deleted before the workspace was deleted stay deleted. Webhook endpoints resume receiving new deliveries; deliveries cancelled by the deletion stay cancelled.

#### `POST /v1/workspaces/{id}/transfer-ownership` — `{"user_id": 7}` → `200` workspace. Owner only. Target must be a member of any role (`422 not_member` at `user_id` otherwise). Previous owner becomes admin. Transfer increments the workspace version and produces exactly two events and no others: `ownership.transferred`, whose target is the new owner, and `member.role_changed`, whose target is the previous owner.

### 7.4 Members

#### `GET /v1/workspaces/{id}/members`

Ordered `joined_at asc, user_id asc`. Items:

```json
{"user": {"id": 7, "name": "Bo", "email": "bo@example.com"}, "role": "member", "joined_at": "…"}
```

#### `POST /v1/workspaces/{id}/members` — `{"email": "bo@example.com", "role": "member"}` → `201` member item. Idempotent.

The user must already exist and be active (`422 user_not_found` at `email`). `role` is `admin`, `member` or `viewer` (`owner` → `422 invalid_enum`). `409 already_member`. Admins may only add `member`/`viewer` (`403` otherwise). Sends a `member_added` email to the new member.

#### `PATCH /v1/workspaces/{id}/members/{user_id}` — `{"role": "viewer"}` → `200`. Changing a member's role to `viewer` clears their `assignee_id` on every non-deleted task of the workspace, with `task.updated` events. The owner's role cannot be changed: `403` when an admin asks (insufficient role is checked first), `409 sole_owner` when the owner asks. `owner` is not an accepted value (`422 invalid_enum`). Admins cannot change admins or promote anyone to `admin` (`403`). A `user_id` that is not a member → `404 not_found`.

#### `DELETE /v1/workspaces/{id}/members/{user_id}` → `204`. Removes the membership (or leaves, when `user_id` is the requester). The owner cannot be removed or leave: `403` when an admin asks, `409 sole_owner` when the owner asks. Admins cannot remove other admins (`403`); any admin may leave. A `user_id` that is not a member → `404 not_found`.

### 7.5 Projects

#### `POST /v1/workspaces/{id}/projects` — `{"name": "Website", "slug": "website", "description": null}` → `201`. Member+. Idempotent. `409 slug_taken`.

```json
{"id": 10, "workspace_id": 3, "name": "Website", "slug": "website", "description": null,
 "creator_id": 1, "version": 1, "created_at": "…", "updated_at": "…", "deleted_at": null}
```

#### `GET /v1/workspaces/{id}/projects`

Ordered by `slug asc, id asc`. Query: `include_deleted=true` (admin+, otherwise `403`) also returns deleted projects.

#### `GET /v1/projects/{id}` → `200` with `ETag`; `410` if deleted or its workspace is deleted.

#### `PATCH /v1/projects/{id}` — `name`, `slug`, `description`. Member+. `If-Match` honoured.

#### `DELETE /v1/projects/{id}` — admin+. `204`. Its tasks and their comments become `410`, disappear from lists and search, and stop producing reminders and digest entries. Pending webhook deliveries are not affected.

#### `POST /v1/projects/{id}/restore` — admin+. `200` project. `409 not_deleted`; `409 slug_taken` when another non-deleted project in the workspace now has the slug. Tasks and comments that were visible at deletion time return; those deleted individually beforehand stay deleted.

#### `GET /v1/projects/{id}/summary`

Aggregates over non-deleted tasks of the project. `410` when the project or its workspace is deleted.

```json
{
  "project_id": 10,
  "task_counts": {"open": 4, "in_progress": 2, "done": 9, "total": 15},
  "overdue_count": 1,
  "estimate_minutes_total": 1260,
  "budgets": [
    {"currency": "USD", "count": 3, "total": "1000.00", "total_minor": "100000", "mean": "333.33", "mean_minor": "33333"},
    {"currency": "JPY", "count": 3, "total": "100", "total_minor": "100", "mean": "33", "mean_minor": "33"}
  ]
}
```

`budgets` is ordered by currency code and omits currencies with no tasks. `mean` is `total / count` rounded half away from zero to the currency's decimals. `overdue_count` uses the requester's timezone.

### 7.6 Tasks

#### `POST /v1/projects/{id}/tasks` — member+. Idempotent.

```json
{"title": "Fix login redirect", "description": "Users land on /404 after SSO.",
 "status": "open", "labels": ["bug", "auth"], "assignee_id": 7, "due_date": "2026-03-20",
 "estimate_minutes": 90, "budget": {"currency": "USD", "amount": "120.5"}}
```

Only `title` is required. `201`:

```json
{"id": 42, "project_id": 10, "workspace_id": 3, "title": "Fix login redirect",
 "description": "Users land on /404 after SSO.", "status": "open", "labels": ["bug", "auth"],
 "assignee_id": 7, "creator_id": 1, "due_date": "2026-03-20", "overdue": false,
 "estimate_minutes": 90, "budget": {"currency": "USD", "amount": "120.50", "amount_minor": "12050"},
 "version": 1, "completed_at": null, "created_at": "…", "updated_at": "…", "deleted_at": null}
```

Creating a task with `assignee_id` sends a `task_assigned` email to the assignee unless the assignee is the actor; its dedupe key uses the id of the `task.created` event. Validation specifics: `assignee_id` that is not an assignable member → `422 not_assignable`; `due_date` not a real calendar date (`2026-02-30`) → `422 invalid_date`; a `labels` array with duplicates → `422 duplicate` at `labels[<index of second>]`.

#### `GET /v1/projects/{id}/tasks` and `GET /v1/workspaces/{id}/tasks`

Both accept the same filters, all combinable with each other and with `cursor`. The project form returns `410` when the project or its workspace is deleted:

| Parameter | Values |
|---|---|
| `status` | one or more of `open,in_progress,done`, comma-separated |
| `assignee_id` | integer, or `me`, or `none` |
| `label` | exact label (compared as in 6.10); repeatable, all must match |
| `due_before`, `due_after` | date, inclusive |
| `overdue` | `true` or `false` (requester's timezone) |
| `project_id` | (workspace list only) integer |
| `sort` | `created_at` (default, descending), `updated_at` (descending), `due_date` (ascending, tasks without due date last, then `id asc`) |
| `include_deleted` | `true` (admin+, otherwise `403`) |

Ordering is `<sort field>, id` with `id` following the direction of the sort field. Without `include_deleted=true` deleted tasks are not returned; with it, individually deleted tasks are returned with `deleted_at` set, while tasks hidden only because their project is deleted are still omitted.

#### `GET /v1/tasks/{id}` → `200` with `ETag`; `410` if the task, its project or its workspace is deleted.

#### `PATCH /v1/tasks/{id}` — member+. `If-Match` honoured. Fields: `title`, `description`, `status`, `labels`, `assignee_id`, `due_date`, `estimate_minutes`, `budget`, `project_id` (another non-deleted project of the same workspace, else `422 invalid_project`).

Produces one `task.updated` activity event whose `changes` lists each changed field with `from`/`to`. Assigning (including a change of assignee) sends a `task_assigned` email to the new assignee unless they are the actor.

#### `POST /v1/tasks/{id}/claim` — member+. No body.

Sets the requester as assignee if and only if the task currently has no assignee. `200` task on success; `409 already_assigned` with `details: [{"path": "assignee_id", "code": "already_assigned", "assignee_id": 7}]` otherwise, including when the requester is already the assignee. Claiming is atomic: for a given unassigned task only one claim succeeds, producing one `task.updated` event, and every other claim receives `409 already_assigned`. A claim sends no email.

#### `DELETE /v1/tasks/{id}` → `204`. `POST /v1/tasks/{id}/restore` → `200` task; `409 not_deleted`. A restored task whose assignee is no longer an assignable member comes back with `assignee_id: null`.

### 7.7 Comments

#### `POST /v1/tasks/{id}/comments` — `{"body": "Reproduced on staging."}` → `201` comment. Member+. Idempotent. `410` if the task is deleted.

Sends a `comment_added` email to the task's assignee and creator (deduplicated, excluding the commenter and deactivated users).

#### `GET /v1/tasks/{id}/comments` — ordered `created_at asc, id asc`. `include_deleted=true` (admin+, otherwise `403`). `410` when the task, its project or its workspace is deleted.

#### `GET /v1/comments/{id}` → `200` with `ETag`.

#### `PATCH /v1/comments/{id}` — `{"body"}`. Author only. Sets `edited: true`. `If-Match` honoured.

#### `DELETE /v1/comments/{id}` → `204`. `POST /v1/comments/{id}/restore` → `200`; `409 not_deleted`.

### 7.8 Activity

#### `GET /v1/workspaces/{id}/activity`

Ordered `occurred_at desc, id desc`. Filters: `type` (comma-separated), `actor_id`, `target_type` (`workspace|member|project|task|comment|webhook`), `target_id`, `since` (timestamp, inclusive), `until` (timestamp, exclusive). Events about deleted objects remain listed.

### 7.9 Search

#### `GET /v1/workspaces/{id}/search?q=login`

Semantics in section 11. Items: `{"task": {…task object…}, "match": "title_prefix" | "title" | "description" | "comment"}`.

### 7.10 Webhook endpoints and deliveries

Admin+ for all of the following.

#### `POST /v1/workspaces/{id}/webhooks` — Idempotent.

```json
{"url": "https://hooks.example.com/taskwell", "events": ["task.created", "task.updated", "comment.created"], "secret": "0f3b7c9e2a4d6f8b1c3e5a7d9f0b2c4e6a8d1f3b"}
```

`events` is a non-empty array of event names from section 8.1, or `["*"]`; an empty array → `422 too_short` at `events`, an unknown name → `422 invalid_event` at `events[n]`. `url` must be `http` or `https`, ≤ 2,048 chars; any host is accepted, including loopback and private addresses. `secret` is 32–256 printable ASCII characters; if omitted, it is generated (32 random bytes, hex). Whether supplied or generated, it is returned only in this response. `201`:

```json
{"id": 5, "workspace_id": 3, "url": "https://hooks.example.com/taskwell", "events": ["task.created", "task.updated", "comment.created"],
 "active": true, "secret": "…", "created_at": "…", "updated_at": "…"}
```

#### `GET /v1/workspaces/{id}/webhooks` — ordered `id asc`; no `secret`.
#### `GET /v1/webhooks/{id}` — no `secret`.
#### `PATCH /v1/webhooks/{id}` — `url`, `events`, `active`. Setting `active: false` stops creating new deliveries; existing pending ones continue.
#### `DELETE /v1/webhooks/{id}` → `204`. The endpoint is removed permanently (later reads of it and of its deliveries return `404`); its pending deliveries are never attempted.

#### `GET /v1/webhooks/{id}/deliveries` — ordered `created_at desc, id desc`. Filter: `status`. Items have the same shape as the single-delivery response below.

#### `GET /v1/webhooks/{id}/deliveries/{delivery_id}`

```json
{"id": 901, "webhook_id": 5, "event": "task.updated", "status": "dead",
 "attempt_count": 6, "next_attempt_at": null,
 "attempts": [
   {"number": 1, "started_at": "…", "finished_at": "…", "outcome": "failure", "status_code": 500, "error": null},
   {"number": 2, "started_at": "…", "finished_at": "…", "outcome": "timeout", "status_code": null, "error": "no response within 5000 ms"},
   … four more …
 ],
 "payload": { … the exact JSON body sent … },
 "created_at": "…", "completed_at": "…"}
```

`status` ∈ `pending | in_progress | succeeded | dead | cancelled`. `outcome` ∈ `success | failure | timeout | error`. `attempt_count` is the total number of attempts across all series, including after redelivery. `completed_at` is set when the status becomes `succeeded`, `dead` or `cancelled` and is `null` otherwise; redelivery resets it to `null`.

#### `POST /v1/webhooks/{id}/deliveries/{delivery_id}/redeliver` → `202` delivery. Allowed only when `status` is `dead` (otherwise `409 not_redeliverable`). Resets `status` to `pending`, places the delivery at the end of the endpoint's order (8.3) and starts a fresh series of six attempts (one immediate, then five on the schedule of 8.3); attempt numbering continues from the previous series. Redelivery produces no activity event.

---

## 8. Webhooks

### 8.1 Events

`task.created`, `task.updated`, `task.deleted`, `task.restored`, `comment.created`, `comment.updated`, `comment.deleted`, `project.created`, `project.updated`, `project.deleted`, `project.restored`, `member.added`, `member.removed`.

This list is exhaustive. The remaining activity types (`workspace.*`, `webhook.*`, `member.role_changed`, `ownership.transferred`, `comment.restored`) appear only in the activity feed; a subscription to `"*"` means every type in this list and nothing else.

Each activity event of one of these types creates one **delivery** per active endpoint of the workspace whose subscription includes the type. A delivery is listed by `GET /v1/webhooks/{id}/deliveries` as soon as the request that caused it has returned; that request never contacts a receiver. Receiver speed or availability does not affect API response times (see 14.2).

### 8.2 Request to the receiver

```
POST <url>
Content-Type: application/json
User-Agent: Taskwell-Webhooks/1
X-Taskwell-Event: task.updated
X-Taskwell-Delivery-Id: 901
X-Taskwell-Attempt: 2
X-Taskwell-Timestamp: 1773151230
X-Taskwell-Signature: v1=7a1c0e4b9d2f6a8c3e5b1d7f9a0c2e4b6d8f1a3c5e7b9d0f2a4c6e8b1d3f5a7c
```

Body (identical bytes on every attempt of the same delivery):

```json
{
  "delivery_id": 901,
  "event": "task.updated",
  "occurred_at": "2026-03-10T14:00:00.000Z",
  "workspace_id": 3,
  "actor": {"id": 1, "name": "Ana", "deleted": false},
  "data": {
    "task": { …task object as returned by GET /v1/tasks/{id} at event time… },
    "changes": {"status": {"from": "open", "to": "done"}}
  }
}
```

`data` contains `task`, `comment` (plus `task_id`), `project` or `member` (same shape as a members-list item) according to the event type, and `changes` where applicable. `overdue` inside webhook payloads is computed in the actor's timezone.

Signature: `X-Taskwell-Timestamp` is the Unix time in seconds (application clock) at which this attempt was made. The signature is the lowercase hex HMAC-SHA256 of the string `<timestamp>.<raw body bytes>` with the endpoint's secret as key. Receivers are expected to reject timestamps older than five minutes.

### 8.3 Delivery semantics

* An attempt is successful when the receiver answers with any 2xx status within `TASKWELL_WEBHOOK_TIMEOUT_MS` (default 5,000 ms). Redirects are not followed and count as failure. Response bodies are ignored.
* Retry schedule after a failed attempt: 30 s, 2 min, 10 min, 1 h, 6 h after the previous attempt finished, on the application clock, without jitter. After the sixth failed attempt of a series the delivery is `dead` and stays inspectable.
* At most one attempt of a given delivery is in flight at any time. An attempt without a complete response within the timeout is recorded as `timeout`. Outcome `failure` means a non-2xx response or a redirect; `error` means the request could not be completed (connection, name resolution or TLS problems, or a worker termination).
* Deliveries to the same endpoint are attempted strictly in creation order, where a redelivered delivery counts as created at the time of the redeliver request, and only one delivery per endpoint is in flight at a time. A delivery that is awaiting a retry blocks the deliveries behind it on the same endpoint until it succeeds, dies or is cancelled. Different endpoints are independent.
* A pending retry becomes due as soon as the application clock reaches its scheduled time.

---

## 9. Notifications and the email sink

Taskwell does not send email over the network. Every email is written to the **outbox**, a durable record kept in the database, and additionally appended as one JSON line to the file named by `TASKWELL_EMAIL_SINK_PATH` when that variable is set. The outbox is readable through `GET /__test/emails` (section 13.4).

### 9.1 Email record

```json
{"id": 77, "to": "bo@example.com", "template": "task_assigned", "subject": "You were assigned: Fix login redirect",
 "dedupe_key": "task_assigned:42:7:1203", "data": {"task_id": 42, "task_title": "Fix login redirect", "workspace_id": 3, "actor_name": "Ana"},
 "sent_at": "2026-03-10T14:00:01.000Z"}
```

`dedupe_key` is unique in the outbox. An email whose dedupe key already exists in the outbox is never written again.

### 9.2 Templates

| Template | Recipient(s) | Trigger | `dedupe_key` | `data` |
|---|---|---|---|---|
| `member_added` | the added user | member added | `member_added:<workspace_id>:<user_id>:<activity_event_id>` | `workspace_id`, `workspace_name`, `role`, `actor_name` |
| `task_assigned` | new assignee, unless actor | assignee set or changed | `task_assigned:<task_id>:<assignee_id>:<activity_event_id>` | `task_id`, `task_title`, `workspace_id`, `actor_name` |
| `comment_added` | task assignee and task creator, excluding the commenter | comment created | `comment_added:<comment_id>:<recipient_id>` | `task_id`, `task_title`, `comment_id`, `author_name`, `body` |
| `task_due` | assignee | section 10.3 | `task_due:<task_id>:<due_date>` | `task_id`, `task_title`, `due_date`, `workspace_id` |
| `daily_digest` | each user with `digest_enabled` | section 10.2 | `daily_digest:<user_id>:<local_date>` | see 10.2 |

Deactivated users never receive email, and `comment_added` is sent only to recipients who are still members of the workspace. Emails are written by the worker, never during the request; once the triggering request has returned, its email is guaranteed to be written even if a process restarts. Subjects of `member_added`, `comment_added` and `task_due` are free-form; the sink file line is the email record JSON exactly as returned by `GET /__test/emails`.

---

## 10. Digest and scheduler

### 10.1 Scheduler

A scheduler evaluation may run in either the API or the worker. Outside test mode one runs every minute; in test mode (section 13.4) one runs only when `POST /__test/scheduler/tick` is called. Each evaluation applies the rules below against the application clock and creates the resulting digest and reminder jobs; running several evaluations within the same minute, or from two instances at once, produces no extra emails.

### 10.2 Daily digest

Each user with `digest_enabled: true` receives one `daily_digest` email per local calendar date, at the first scheduler run at or after 08:00 local time in the user's timezone. 08:00 local time is determined by the zone's rules in force on that date.

If the first scheduler run at or after a user's 08:00 happens later that day, the digest is sent at that run; digests for earlier dates are never sent. No user receives two digests for the same date.

The digest is sent even when all of its sections are empty. Subject: `Your Taskwell digest for <local_date>`. `data`:

```json
{
  "date": "2026-03-08",
  "timezone": "America/New_York",
  "overdue": [{"task_id": 42, "title": "…", "due_date": "2026-03-05", "project_id": 10, "workspace_id": 3}],
  "due_today": [{"task_id": 43, "title": "…", "due_date": "2026-03-08", "project_id": 10, "workspace_id": 3}],
  "activity_count": 4
}
```

* `overdue`: non-deleted tasks assigned to the user, status not `done`, `due_date` earlier than `date`, in non-deleted projects and workspaces, ordered `due_date asc, id asc`.
* `due_today`: same, with `due_date` equal to `date`.
* `activity_count`: number of activity events in the 24 hours ending at the moment the digest is generated, whose target is a task currently assigned to the user, excluding events whose actor is the user.

### 10.3 Due-date reminders

At the first scheduler run at or after 09:00 local time in the assignee's timezone on the task's `due_date`, if the task is still not `done`, not deleted, and has that assignee, a `task_due` email is sent to the assignee. A reminder is sent at most once per task and due date; the rule applies only while the assignee's local date equals `due_date`, so a reminder that was not sent on the due date is never sent later. Changing the due date makes the task eligible again for the new date.

---

## 11. Search

`GET /v1/workspaces/{id}/search?q=<text>` finds non-deleted tasks in non-deleted projects of the workspace. `q` is trimmed and must be 2–100 characters after trimming (`400 invalid_query` otherwise). The query is a single phrase; it is not split into words.

Matching is a substring test after applying the normalisation of 6.10 to both the query and the text. A task matches when the phrase occurs in its title, its description, or the body of any of its non-deleted comments. Each matching task appears once, with the best of the following matches:

| Rank | `match` | Condition |
|---|---|---|
| 1 | `title_prefix` | the normalised title starts with the phrase |
| 2 | `title` | the title contains the phrase elsewhere |
| 3 | `description` | the description contains the phrase |
| 4 | `comment` | a non-deleted comment contains the phrase |

Results are ordered by rank, then `updated_at desc`, then `id desc`, and cursor-paginated like every list. Comments by deactivated users count. Viewers may search.

---

## 12. Background worker

All asynchronous work — webhook attempts, emails, digests, reminders, idempotency-record expiry — is carried out by the worker as **jobs**. Work accepted by the API is carried out even if the worker starts only afterwards or restarts in between.

* A successful API response implies that the work it triggers is listed by `GET /__test/jobs` and will be carried out.
* A job may be executed more than once; every job's effect is written so that executing it a second time produces no additional email, delivery attempt or activity. Work survives abrupt termination of a worker at any moment: after a restart every job completes without a duplicate email or delivery attempt, and interrupted work resumes within 60 seconds (application clock) of a worker being available. A webhook attempt interrupted by such a termination is recorded as an attempt with outcome `error` and error text `worker terminated`; it counts toward the six attempts and the next attempt carries the next `X-Taskwell-Attempt` number. Its `finished_at` is the moment the interruption is detected by a worker, and the retry delay of 8.3 is measured from that moment.
* Two worker instances may run at the same time without duplicating any effect.
* A job that fails is retried with the schedule 10 s, 1 min, 5 min, 30 min, then marked `dead` after its fifth failure and left in place; a dead job must not prevent other jobs from being processed. Webhook attempts have their own schedule (8.3) and are not subject to this one.
* The worker has no HTTP interface. Its state is observable through the test endpoints of 13.4 and through its logs.

---

## 13. Operational contract

### 13.1 Commands

All commands run on Linux. The repository root must contain these executables (shell scripts are fine). Each reads its configuration from environment variables only.

| Command | Purpose |
|---|---|
| `./bin/setup` | Install dependencies and create or migrate the database schema. Idempotent. |
| `./bin/api` | Start the HTTP API in the foreground on `TASKWELL_BIND:TASKWELL_PORT`. Brings the database schema up to date first if needed. Ready to serve within 10 seconds. |
| `./bin/worker` | Start one worker instance (jobs and scheduler) in the foreground. Safe to run two instances. |
| `./bin/test` | Run the project's automated test suite and exit non-zero on failure. |

Both `./bin/api` and `./bin/worker` must exit cleanly on `SIGTERM` within 5 seconds and must tolerate `SIGKILL`.

### 13.2 Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TASKWELL_DATABASE_URL` | required | Database connection string in the form the supported engine understands. The README lists the supported engines (SQLite, PostgreSQL, or both) with an example value for each. |
| `TASKWELL_BIND` | `0.0.0.0` | Listen address. |
| `TASKWELL_PORT` | `8080` | Listen port. |
| `TASKWELL_TEST_MODE` | `false` | `true` enables the `/__test/*` endpoints and disables the scheduler's automatic minute tick. Must never be enabled by default. |
| `TASKWELL_EMAIL_SINK_PATH` | unset | When set, every outbox email is also appended to this file as one JSON line. |
| `TASKWELL_WEBHOOK_TIMEOUT_MS` | `5000` | Per-attempt receiver timeout. |
| `TASKWELL_TRUST_PROXY` | `false` | Use `X-Forwarded-For` for the client IP. |
| `TASKWELL_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

### 13.3 Logging

One line per request on the API (method, path, status, duration, actor id), one line per job execution on the worker (job id, type, attempt, outcome, duration), as structured text or JSON. Secrets (API keys, webhook secrets) never appear in logs.

### 13.4 Test endpoints

Available only when `TASKWELL_TEST_MODE=true`; otherwise every `/__test/*` path returns `404`. They require no authentication, are exempt from rate limits, and are served by the API. A clock change made through these endpoints is observed by the API and every running worker before the call returns.

| Endpoint | Behaviour |
|---|---|
| `POST /__test/reset` | Deletes all data (users, workspaces, jobs, outbox, idempotency records, rate-limit counters), clears the clock override. `204`. Must complete within 5 s on an empty-to-moderate database. |
| `GET /__test/clock` | `200 {"now": "<timestamp>", "overridden": false}`. |
| `PUT /__test/clock` | Body `{"now": "<timestamp>"}`. Freezes the application clock at that instant for the API and every worker. `200` with the clock object. |
| `POST /__test/clock/advance` | Body `{"seconds": 3600}` (non-negative integer, may be large; negative → `422 out_of_range`). Moves the frozen clock forward. `400 clock_not_overridden` if the clock is not overridden. |
| `DELETE /__test/clock` | Removes the override; real time resumes. `204`. |
| `POST /__test/scheduler/tick` | Runs one scheduler evaluation synchronously (digests, reminders) and returns `200 {"digests_created": n, "reminders_created": n}`. Jobs it creates are executed by the worker. |
| `POST /__test/jobs/drain` | Blocks until no due job is `pending` or `running`, or 30 s have elapsed. A job is due when its scheduled time is at or before the application clock; a webhook delivery waiting behind an earlier delivery of the same endpoint is not due. `200 {"drained": true, "pending": 0, "running": 0, "dead": 1}` (`drained: false` on timeout). Jobs are carried out only while a worker is running. |
| `GET /__test/jobs?status=<pending\|running\|succeeded\|dead>` | `200 {"data": [{"id", "type", "status", "attempt_count", "run_at", "last_error"}]}`, ordered `id desc`, at most 1,000. `type` ∈ `webhook_delivery \| email \| digest \| reminder \| maintenance`. A job awaiting a retry is `pending` with `attempt_count` > 0. |
| `GET /__test/emails?to=&template=&dedupe_key=` | `200 {"data": [email records]}` ordered `sent_at asc, id asc`, all matching records. |
| `DELETE /__test/emails` | Empties the outbox, including its record of dedupe keys. `204`. |
| `POST /__test/seed` | Body `{"profile": "reference"}`. Populates the reference dataset of 14.1 into an empty database and returns `200 {"users": [{"email", "api_key", "workspace_ids": [...]}]}` for ten users with varied roles. May take up to five minutes. `409 database_not_empty` if the database is not empty. Seeded webhook endpoints are created with `active: false`. |

While the clock is overridden it does not advance on its own. All other time-dependent behaviour — `overdue`, rate-limit windows, idempotency expiry, webhook retry due times, job retry times, the 60-second recovery of interrupted jobs, digest and reminder evaluation, `X-Taskwell-Timestamp`, every `*_at` written — uses the overridden value. Per-operation timeouts and durations (receiver timeout, drain wait, startup and shutdown limits, reset and seed durations) use real time; every other rule uses the application clock.

---

## 14. Non-functional requirements

### 14.1 Reference dataset

Produced by `POST /__test/seed`: 2,000 users across 60 timezones; 50 workspaces with 20–80 members each; 400 projects, including at least one with 2,000 tasks; 100,000 tasks (roughly 60 % with due dates spread over ±180 days, 50 % with budgets in at least four currencies, 15 labels in use); 300,000 comments; one webhook endpoint per workspace; activity events for every object.

### 14.2 Targets

Measured on the reference dataset, on one machine, with the API and one worker running, 50 concurrent clients, after a two-minute warm-up:

| Operation | p99 |
|---|---|
| `GET` single object | 50 ms |
| List endpoints with `limit=50`, any filter combination | 300 ms |
| `GET /v1/workspaces/{id}/search` | 800 ms |
| `POST`/`PATCH` of a task or comment (including activity, job and delivery creation) | 150 ms |
| `GET /v1/projects/{id}/summary` for a project with 2,000 tasks | 300 ms |

Also:

* `./bin/api` ready to serve within 10 s of start; worker picks up a newly created job within 2 s (real clock) when idle.
* Webhook first attempt starts within 2 s (real clock) of the triggering request completing, when the endpoint has no earlier delivery still outstanding.
* The targets also apply while a webhook receiver accepts connections but never responds.
* Total resident memory of everything started by `./bin/api` stays below 512 MiB, and of each `./bin/worker` instance below 512 MiB, under the load above.

---

## 15. Deliverables and definition of done

1. Source code in a single repository with the `./bin/*` commands of 13.1.
2. `README.md` with: the supported database engines (SQLite, PostgreSQL, or both) and how to provision each; exact steps to run API and worker locally; how to run the test suite; a list of every environment variable; any assumptions made where this specification was silent, each stated explicitly.
3. Automated tests for the behaviour in this specification, runnable with `./bin/test`.
4. Optional: a machine-readable API description (for example OpenAPI).
5. Definition of done: every endpoint in section 7 behaves as described; all invariants of 3.11 hold; the test endpoints of 13.4 work; the performance targets of 14.2 are met on the reference dataset; `./bin/setup && ./bin/api` and `./bin/worker` start from a clean checkout following only the README.

Where this specification is silent or ambiguous, choose a behaviour and document the assumption in the README.
