# Taskwell — DONE

Date: 2026-10-25. Framework: murmur 0.2.1. Database: SQLite (Node 26 `node:sqlite`).

## What is implemented

Every endpoint of SPEC §7, the webhook pipeline of §8, the email outbox of §9, the digest/reminder scheduler of
§10, search of §11, the background worker of §12, the operational contract of §13 (commands, environment
variables, logging, test endpoints) and the reference dataset seed of §14.1.

- 26 pieces in three groups (`pieces/api/*` edges, `pieces/app/*` domain, `pieces/worker/*` worker), 70 contracts,
  61 HTTP routes, 6 app-local capabilities (`db`, `time`, `kit`, `ledger`, `web`, `front`). `pnpm exec murmur
  catalog` lists them; `pnpm exec murmur check` has zero errors (only the expected `route-family-split` warnings
  because every edge serves `/v1`, and `folder-local-files` warnings where a piece test reads a sibling schema).
- Invariants of §3.11: one owner per workspace (transfer is one transaction), one assignee with assignability
  checks, slug/email uniqueness enforced by partial unique indexes plus pre-checks, `version` +1 per change (incl.
  delete/restore/claim/unassign/transfer/empty PATCH), exactly the specified activity events per request — all
  written in the same SQLite transaction as the change through the `ledger` capability.
- Precedence 429 → 401 → 404 → 410 → 403 → 400/413/415 → 422 → 409 via the `app/gate` piece and the edge pipeline
  described in `pieces/api/context.md`.
- Idempotency-Key, If-Match, cursor pagination (keyset, bound to endpoint and filters), rate limiting with
  `RateLimit-*`/`Retry-After` headers, soft delete/restore chains, test clock shared across processes through the
  database, two-worker safety (atomic `UPDATE … RETURNING` claims, per-endpoint ordering, 60 s recovery of
  interrupted jobs, `worker terminated` attempts).
- `./bin/setup`, `./bin/api`, `./bin/worker`, `./bin/test` work from a clean checkout following only `README.md`
  (verified by cloning `main` to a temp directory: setup, 624 green tests, API ready in < 1 s, SIGTERM exit in
  ~35 ms, SIGKILL leaves nothing behind).

## Tests

`./bin/test` runs 624 tests in ~15 s: unit tests per piece and capability (`testPiece` + in-memory SQLite), contract
tests, and end-to-end tests under `test/` that boot the whole app in-process over a temp database and drive it over
HTTP, plus a process-level test that spawns `./bin/api` and `./bin/worker`.

## How SMOKE.md was verified

1. Automated: `test/smoke.test.ts` runs the 13 walkthroughs in order against one fresh in-process instance (API +
   worker pieces), including the webhook receiver with the HMAC recomputed over `<timestamp>.<body>` (scenario 11)
   and the clock timeline of scenario 13. It is part of `./bin/test`.
2. Manual: scenarios 1–10, 12 and 13 were also run with `curl` against real `./bin/api` and `./bin/worker`
   processes (`TASKWELL_TEST_MODE=true`) on a fresh database twice during the project, the last time on the final
   `main`; scenario 11 (webhook delivery through the real processes) is covered by `test/e2e-process.test.ts`.

## Performance (reference dataset, 50 concurrent clients, one API process, local workstation)

Seed via `POST /__test/seed`: ~9 s. Measured p99 (ms): GET single object 42–85 (target 50; the task GET set
included 404s), list `limit=50` 45–470 depending on filters (target 300; the slow case is `assignee_id=none&overdue=true`
at ~11 ms per request, queued 50-deep), activity 129, members 60, summary of the 2 000-task project 133 (target 300),
POST task 94 (target 150), search 1 105 before issue 031 (target 800). Single-request costs after 031: search 6–11 ms,
lists 2–11 ms, GET 1.6–2.5 ms. With one process every request is serialised on one SQLite connection, so p99 ≈ 50 ×
the per-request cost; the targets for GET single object and the heaviest list filters are within ~1.5× and search is
now expected inside the target (not re-measured under 50 clients after 031). Running more than one API process is
allowed by the spec but would require moving the rate-limit counters out of process memory (see below).

## Missing or partial

- Performance targets of §14.2 are met for POST/PATCH, summary, activity and members; GET single object and the
  heaviest task-list filters are borderline, search unverified under load after the tuning. No two-minute warm-up
  benchmark with a dedicated load tool was run.
- Rate-limit counters live in the API process memory (one API process per `./bin/api`); several API processes
  would each count separately.
- `pnpm lint` (oxfmt) flags the Markdown files in `issues/` and `PLAN.md`; `murmur check` and `./bin/test` are the
  gates and are clean.

## Known defects and deliberate deviations

- The framework's built-in `GET /healthz` cannot be overridden and the http request does not expose the peer
  address; `./bin/api` therefore runs a small reverse proxy capability (`capabilities/front`) in front of the murmur
  server that answers `/healthz` per spec and forwards the socket address. In-process test runtimes (and `murmur
  dev`) still show the framework body `{"ok":true}`. See `FRAMEWORK-ISSUES.md` (9 entries).
- Case folding is approximated (NFKC + `toUpperCase().toLowerCase()` + a small fix-up table); timezone names must
  start with an uppercase letter per `/`-segment; input timestamps need an explicit offset; combining marks count
  as letters in slugs. All assumptions are listed in `README.md`.
- A non-integer path id answers `404 not_found` (SPEC 6.1 names "a non-integer id" only among query parameters).
- With `TASKWELL_TRUST_PROXY=true` the first `X-Forwarded-For` value is trusted as given.
- Killing the API or worker with SIGKILL abandons in-flight work; the worker's recovery (60 s on the application
  clock) records interrupted webhook attempts as `error` / `worker terminated` as specified.

## Process summary

32 issues (`issues/*.md`), all merged; 1 fix issue was opened when `main` went red (a timing-sensitive test, issue
030). Every branch was reviewed by an adversarial reviewer; 9 branches needed one fix round, none needed a third.
