# Taskwell — completion report

Date: 2026-10-25. All 14 issues in `issues/` are merged into `main`; none were dropped. `./bin/test` on `main` runs 44 suites / 611 tests green in about 17 s.

## What is implemented

Everything in `SPEC.md` sections 3–13, as a NestJS 12 modular monolith on Node 26 with SQLite through the built-in `node:sqlite` module (see `PLAN.md` for architecture and `README.md` for operation and assumptions):

- **Users and API keys** (7.2): registration with a first key, `me` read/update/deactivate (`sole_owner` guard, membership removal with task unassignment), user lookup by shared workspace, key list/create/revoke, 20-key limit.
- **Authentication, authorization, rate limiting** (4, 5, 6.8): bearer keys hashed with SHA-256, the full `429 → 401 → 404 → 410 → 403 → 400/413/415 → 422 → 409` precedence (bodies are parsed only after authorization), the 5.2 permission matrix, all four rate-limit buckets with `RateLimit-*`/`Retry-After` headers and `X-Forwarded-For` support.
- **API conventions** (6): the 6.2 error format and every 6.3 code, 404/405 route handling, 64 KiB body limit, media-type checks, unknown-field rejection, cursor pagination bound to endpoint and filters, idempotent creation with replay/`idempotency_key_reused`/`idempotency_in_progress` and 24 h expiry, `If-Match` optimistic concurrency with `version_conflict` details, partial updates with `not_nullable`, NFC/NFKC/case-fold text handling, money with exact BigInt arithmetic.
- **Workspaces, members, projects, tasks, comments** (7.3–7.7): CRUD, soft delete/restore with the documented visibility rules, slug derivation and uniqueness, ownership transfer, member role rules with task unassignment, task filters/sorts/claim/summary, `overdue` in the requester's timezone, comment author rendering for deactivated users.
- **Activity feed** (3.9, 7.8) with every event type and filter; **webhooks** (7.10, 8): endpoint CRUD, signed deliveries with the 8.2 headers, the 8.3 retry schedule, strict per-endpoint ordering, recovery of interrupted attempts (`worker terminated`), cancellation on workspace deletion, redelivery.
- **Emails and outbox** (9): all five templates with dedupe keys, outbox table plus `TASKWELL_EMAIL_SINK_PATH` lines, recipient re-checks at send time.
- **Scheduler** (10): daily digests at the first run at or after 08:00 local time, due-date reminders at 09:00 local time, idempotent across repeated and concurrent evaluations.
- **Search** (11): substring search over titles, descriptions and comments with the four match ranks, backed by FTS5 trigram indexes scoped per workspace and verified with `instr()`.
- **Worker** (12): durable jobs in SQLite, atomic claims, generic retry schedule and dead jobs, stale-lock recovery, safe with two instances, graceful SIGTERM.
- **Operational contract** (13): `bin/setup`, `bin/api`, `bin/worker`, `bin/test`; all `TASKWELL_*` variables; structured JSON request and job logs without secrets; every `/__test/*` endpoint including `seed` (reference dataset in about 7 s).
- **Non-functional** (14): `scripts/perf/bench.sh` seeds the reference dataset and drives 50 concurrent clients; every 14.2 p99 target is met with a wide margin (worst measured p99 about 41 ms against targets of 50–800 ms); API RSS about 150–180 MiB and worker about 108 MiB. Figures are in `README.md`, "Performance".

## Missing or partial

- `openapi.yaml` (optional per 15.4) was not written.
- Only SQLite is supported; PostgreSQL is not (allowed by 1 and 15.2).
- Full Unicode case folding is approximated by `toUpperCase().toLowerCase()` after NFKC (assumption A1); exotic folding cases may differ from the CaseFolding.txt C+F mapping.
- Rate-limit counters live in the memory of the single API process (A8); running several API processes would give each its own counters.
- Search phrases shorter than three code points use an `instr()` scan over the workspace's tasks and comments (linear in workspace size, measured at about 11 ms on the reference dataset).

## Known defects and rough edges

- Two processes starting simultaneously on a brand-new, not yet created database file occasionally fail with `database is locked` while applying the first migration (measured about 3–5 % in a 100-run stress test; no double application). Starting one process first, as `./bin/setup` does, avoids it.
- If the API process dies between recording an idempotency key as in progress and completing it, that key answers `409 idempotency_in_progress` until it expires 24 h later.
- The outbox row is committed before the sink-file line is appended; a crash or a failed append between the two leaves a row without a line (never a duplicate line).
- Latency p99 of 25–40 ms under the benchmark load comes from occasional event-loop stalls of the synchronous SQLite driver (WAL checkpoints, large searches); well within targets but not isolated further.
- The smoke script checks scenario 6's activity order by event type only and does not assert "newest first" in scenario 9 beyond page composition; the e2e suites cover both.

## How SMOKE.md was verified

`scripts/smoke.mjs` encodes the thirteen walkthroughs literally (status codes, fields, headers, HMAC verification for scenario 11, the digest clock sequence for scenario 13) and ends with a worker-integrity check (unique dedupe keys, exactly one attempt for the delivered webhook, sequential attempt numbers).

Verification performed by the lead on the final `main` commit, from a fresh `git clone` into an empty directory following only `README.md`:

1. `./bin/setup` (exit 0), then `./bin/api` and one `./bin/worker` with `TASKWELL_TEST_MODE=true` and a sink path on a new SQLite file; `/healthz` answered within about one second.
2. `scripts/smoke.mjs` → 13/13 PASS plus the integrity check; the sink file held 6 lines (two `member_added`, one `comment_added`, three `daily_digest`).
3. A second `./bin/worker` was started and the script run again → 13/13 PASS with the integrity check (no duplicate emails or attempts with two workers).
4. SIGTERM to the API and both workers → all exited with code 0 well within 5 s.

Independently, the issue-013 reviewer ran the smoke script (one API, two workers) and the full benchmark twice; both passed.

## Process summary

Fourteen issues, each implemented by one agent in its own worktree and reviewed adversarially by a different agent. One issue (005, webhook delivery engine) needed a fix round for a queue-ordering bug found in review; issue 014 was opened when `main` went red on load-induced test timeouts and fixed the test harness (supertest was binding a new port per request). Every merge was followed by `./bin/test` on `main`. No NestJS defects were encountered (`FRAMEWORK-ISSUES.md`).
