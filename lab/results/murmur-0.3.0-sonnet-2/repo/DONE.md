# Taskwell — DONE

Date: 2026-10-25. Every issue in `issues/` (001–020) is merged into `main`; none was dropped. `./bin/test` runs
575 tests (unit tests per piece and lib, plus the end-to-end suite under `e2e/`) and passes.

## What is implemented

- The whole HTTP contract of SPEC section 7 on murmur 0.3.0: users and API keys, workspaces and members (roles,
  ownership transfer, leave/remove cascades), projects (incl. summary), tasks (filters, sorts, keyset paging, claim,
  soft delete/restore, unassignment cascades), comments, activity feed, search, webhook endpoints, deliveries and
  redelivery, `GET /healthz`, and all `/__test/*` endpoints of 13.4 (reset, clock override, scheduler tick, jobs
  drain/list, emails, seed).
- Cross-cutting rules: authentication and the four rate-limit buckets with `RateLimit-*`/`Retry-After` headers in one
  guard; status precedence enforced inside domain handlers (404 → 410 → 403 → 400/422 → 409); `Idempotency-Key`
  replay semantics with an app-owned store; `If-Match`/`ETag` optimistic concurrency; NFC/trim input handling and
  NFKC+case-fold comparisons; money in minor units with exact aggregation; cursors bound to endpoint and filters.
- Asynchronous work as durable framework jobs with app-level ledgers: webhook deliveries (per-endpoint strict
  ordering, 30 s/2 m/10 m/1 h/6 h retries, dead after six, redelivery, crash recovery as `worker terminated`,
  cancellation on workspace deletion), emails (outbox + optional sink file, dedupe keys), daily digests and due-date
  reminders on the application clock, idempotency-record expiry. Two worker instances are safe by construction
  (framework job claims plus unique constraints).
- Operational contract: `./bin/setup`, `./bin/api`, `./bin/worker`, `./bin/test`; env variables of 13.2 mapped to
  the framework; structured JSON logs (one access line per request, one line per job run); SIGTERM exits in well
  under a second; `scripts/smoke.sh` runs the thirteen SMOKE.md walkthroughs; `scripts/perf.mjs` and `PERF.md`
  cover the 14.2 targets on the seeded reference dataset.
- `README.md` documents engine support, run steps, tests, every variable and all assumptions; `PLAN.md` holds the
  architecture and data model; `FRAMEWORK-ISSUES.md` records three framework defects with their workarounds.

## What is missing or partial

- PostgreSQL is not supported (SQLite only, as allowed by the spec).
- No machine-readable API description (OpenAPI was optional).
- Unicode case folding is an approximation (`normalize('NFKC')` + upper/lower round trip with a final-sigma fix),
  not the CaseFolding.txt tables; known deviation: Cherokee letters.
- Body syntax failures (malformed JSON, non-object body, 415, 413) are answered before the visibility check because
  the framework reads the body before the domain is asked; the rest of the precedence chain is exact.
- `GET /__test/jobs` lists jobs of types `webhook_delivery`, `email`, `digest`, `reminder`; `maintenance` runs are
  not listed, ids are unique per type (one ledger per worker piece) and items are ordered `created_at desc, id desc`.
- Performance was measured with 50 clients carrying ~0.6 s think time (≈80 req/s offered) because the spec's per-key
  rate limits cap what ten seeded keys may send; all p99 targets are met with a wide margin (see `PERF.md`), but p99
  under heavier server-side contention was not measured.

## Known defects

- One smoke run out of several dozen failed scenario 11 (the receiver saw no request after `drain`) during issue 020
  on a machine where stale api/worker processes from an earlier run were still holding the port. It never reproduced
  on clean instances (three reviewers and the lead ran 50+ clean cycles, incl. two-worker and delayed-worker starts).
  Recorded in `PERF.md`; the suspected cause was the pre-019 "early job" path, since fixed.
- Resident memory of the API spikes to about 780 MiB while `POST /__test/seed` runs (one-off; it drops back below
  300 MiB afterwards). Under the measured load the API stays at ≤ 371 MiB and the worker at ≤ 187 MiB.
- `murmur check` reports `route-family-split` warnings because the `/v1` family is served by six edge pieces; this
  was a deliberate sizing choice (one edge would exceed the handler cap).

## How SMOKE.md was verified

1. `e2e/smoke.test.ts` has one test per walkthrough (`smoke 1` … `smoke 13`) run by `./bin/test` against
   `createTestApp()` (every piece in one process over real HTTP, jobs run with the framework's drain).
2. `scripts/smoke.sh <base-url>` drives the thirteen walkthroughs over HTTP against a real `./bin/api` plus
   `./bin/worker` pair in test mode, with its own webhook receiver and HMAC check.
3. Final verification by the lead on a fresh `git clone` of `main`, following only `README.md`:
   `./bin/setup` (0.4 s), `./bin/api` ready in 1.1 s, `./bin/worker` started, `scripts/smoke.sh` three times in a
   row → `ok 1` … `ok 13`, exit 0 each time; SIGTERM to both processes → both gone within 0.06 s (reviewers recorded
   exit code 0 for each); `./bin/test` in the clone → 575 passed, 0 failed. The seed of the reference dataset
   completed in about 31 s during issue 020's run.
