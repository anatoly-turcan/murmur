# Taskwell hidden acceptance suite (sealed during the experiment)

Black-box HTTP acceptance tests for a Taskwell build: v1 (`../SPEC.md`, 692 tests) and the phase-2 change
requests CR-1..3 (`../experiment/PHASE2.md`, 77 tests, selected with `SUITE_CR`; see "Change-request modes"). Never share
this directory, its results or its test names with building teams.

- Node 26+, TypeScript run natively by Node (type stripping), tests on `node:test` and global `fetch`.
- No runtime dependencies. `pnpm install` only fetches `typescript` and `@types/node` for `pnpm typecheck`.
- Every test resets the candidate with `POST /__test/reset` and builds its own fixtures, so files and tests
  run in isolation and in any order. Files run serially (`--test-concurrency=1`) because they share one
  candidate database and one application clock.

## Running against a candidate

1. Start the candidate from its repository, following its README, with:

   | Candidate env | Value | Why |
   |---|---|---|
   | `TASKWELL_TEST_MODE` | `true` | enables `/__test/*` (reset, clock, tick, drain, jobs, emails) |
   | `TASKWELL_TRUST_PROXY` | `true` | the suite gives every synthetic user its own `X-Forwarded-For` address so per-IP rate limits (SPEC 6.8) do not leak between fixtures; the J1 tests rely on it too |
   | `TASKWELL_WEBHOOK_TIMEOUT_MS` | `1000` | must equal `SUITE_CANDIDATE_WEBHOOK_TIMEOUT_MS` (default 1000); keeps timeout tests short |
   | `TASKWELL_EMAIL_SINK_PATH` | optional | set it, and `SUITE_EMAIL_SINK_PATH` to the same file, to let G1 also check the sink |
   | `TASKWELL_AUDIT_RETENTION_DAYS` | `30` (CR-3 runs) | must equal `SUITE_CANDIDATE_AUDIT_RETENTION_DAYS` (default 30, as in CR-3 acceptance criterion 6) |
   | `TASKWELL_DATABASE_URL`, `TASKWELL_BIND`, `TASKWELL_PORT` | per candidate README | |

   Run `./bin/api` and **two** `./bin/worker` instances (SPEC 3.11 and 12 allow two; F5 and G2 exercise it).
   The candidate must be able to reach the suite's in-process webhook receivers at `SUITE_RECEIVER_HOST`
   (default `127.0.0.1`, i.e. same host).

2. Run the suite:

   ```bash
   cd lab/suite
   TASKWELL_BASE_URL=http://127.0.0.1:8080 scripts/run.sh <output dir>/suite
   # a subset:
   TASKWELL_BASE_URL=http://127.0.0.1:8080 scripts/run.sh /tmp/out tests/f-webhooks.test.ts
   ```

   `run.sh` checks `TASKWELL_BASE_URL`, waits for `GET /healthz`, runs every `tests/**/*.test.ts` under a global
   timeout, and writes into the output directory:

   - `results.json` — per-test results plus summary (written incrementally, so it survives a global timeout; `complete` says whether the run finished)
   - `results.md` — the same as tables
   - `spec.log` — the full `node:test` spec output with assertion diffs

   Exit code is 0 whenever results were produced (failing tests are data, not a harness error); 2 bad usage,
   3 candidate never became healthy, 4 no results produced.

### Suite environment

| Variable | Default | Meaning |
|---|---|---|
| `TASKWELL_BASE_URL` | required | candidate base URL, no trailing `/v1` |
| `SUITE_GLOBAL_TIMEOUT_S` | `3600` | hard stop for the whole run |
| `SUITE_TEST_TIMEOUT_MS` | `180000` | per-test timeout |
| `SUITE_HEALTH_WAIT_S` | `60` | how long to wait for `/healthz` |
| `SUITE_REQUEST_TIMEOUT_MS` | `40000` | per-HTTP-request timeout (drain may block 30 s) |
| `SUITE_CANDIDATE_WEBHOOK_TIMEOUT_MS` | `1000` | the candidate's `TASKWELL_WEBHOOK_TIMEOUT_MS` |
| `SUITE_RECEIVER_HOST` | `127.0.0.1` | host the candidate uses to reach the receivers (put in webhook URLs) |
| `SUITE_RECEIVER_BIND` | `0.0.0.0` | address the receivers listen on |
| `SUITE_WORKER_STOP_CMD` | unset | shell command that SIGKILLs every candidate worker and returns once they are gone |
| `SUITE_WORKER_START_CMD` | unset | shell command that ensures the candidate's two workers are running (idempotent: tests call it again during cleanup) and returns |
| `SUITE_EMAIL_SINK_PATH` | unset | path of the candidate's `TASKWELL_EMAIL_SINK_PATH` file |
| `SUITE_CR` | `none` | change-request mode: `none`, `CR-1`, `CR-2` or `CR-3` (cumulative), see below |
| `SUITE_LEGACY_MANIFEST` | unset | manifest written by `scripts/seed-legacy.ts`; enables the pre-migration (legacy) tests |
| `SUITE_CANDIDATE_AUDIT_RETENTION_DAYS` | `30` | the candidate's `TASKWELL_AUDIT_RETENTION_DAYS` (CR-3) |

The G1/G3 crash-recovery tests need the two worker commands (the orchestrator that launched the candidate
knows the PIDs); without them those tests are reported as `skip`, not `fail`. The stop command must be fast
(well under `SUITE_CANDIDATE_WEBHOOK_TIMEOUT_MS`): G3 kills the worker while a webhook attempt is in flight.

## Change-request modes (`SUITE_CR`)

Phase 2 (EXPERIMENT.md 5.3, G13) re-runs the suite after each change request. `SUITE_CR=CR-N` says that CR-1..CR-N
have been delivered (modes are cumulative: `CR-2` implies CR-1, `CR-3` implies both). The mode does three things:

1. **Adapts the v1 tests' calls** to what PHASE2 changes, so every v1 test stays runnable under its v1 name (the
   harness counts regressions by name). The adaptation lives in `lib/` only; v1 tests keep their assertions.

   | Mode | v1 call change | Where |
   |---|---|---|
   | `CR-1`+ | Every `POST /v1/workspaces` without `organization_id` gets one injected: a per-test steward user (digest off) owns one organization per workspace creator, on the `business` plan, and enrolls the creator as `org_member`. v1 limits, buckets and visibility therefore stay as v1 tests expect (creators hold no org-level read rights; the business plan has no member/workspace caps, 50 webhooks and 6000 requests/minute). Before `POST /v1/workspaces/{id}/transfer-ownership` the target is enrolled in that organization ("a workspace owner must be an org member"). A `rawBody` that parses as a JSON object (Content-Type absent or `application/json…`) gets the same injection; unparseable, non-object and non-JSON raw bodies are left untouched so the 400/415/422 raw-body tests keep their meaning. Requests sent with `raw: true` are never adapted. | `lib/cr-adapter.ts` (hooked into `lib/client.ts` `request`) |
   | `CR-2`+ | Ids are opaque: `User.id`/`keyId` and slots are `Id = number \| string`; numeric sorts use `compareIds` (UUID byte order = lowercase string order); "nonexistent id" is a valid-format UUIDv7; integer checks (`typeof id`, `/^\d+$/`, `Number(header)`) go through `assertPublicId`/`idPattern`/`idFromHeader`; expected tie orders are computed from ids (`idsDesc`, `byCreation`) instead of assuming creation order; "events after a mark" use a seen-set instead of `id >`. `/__test/jobs` ids may stay integers (CR-2 does not list jobs). | `lib/ids.ts`, `lib/endpoints.ts` |
   | `CR-3` | none (audit is additive) | |

   v1 tests made obsolete by a CR are skipped in that mode with `obsolete under CR-N: <reason>`:

   | Test | From | Reason |
   |---|---|---|
   | `[L3] same Idempotency-Key and body on a different endpoint type is not replayed` | CR-1 | the workspace body must now carry `organization_id`, which a project body cannot, so the "same body" premise is impossible; `[L3] … on a different project` keeps L3 covered |

   One assertion is mode-dependent rather than skipped: `[F2]` checks "delivery ids ascend with creation order" in
   v1 and only distinctness under CR-2 (UUIDv7s minted in one frozen millisecond carry no creation order); the
   delivery *order* assertions are unchanged.

2. **Adds the CR test files** `tests/crN-*.test.ts` when `N <= mode` (`scripts/run.sh` selects them by name; run
   directly, a file above the mode reports its tests as `skip`).

   | File | Tests | Covers |
   |---|---:|---|
   | `cr1-organizations.test.ts` | 20 | org CRUD, plan defaults, slugs, members, usage (`[CR1-H]`); role table (`[CR1-R]`); cross-org leaks (`[CR1-S]`); lifecycle and invariants (`[CR1-O]`); org activity (`[CR1-EV]`) |
   | `cr1-access.test.ts` | 4 | AC3 org_admin as viewer, AC4 removal cascade, AC5 `sole_owner` |
   | `cr1-limits.test.ts` | 4 | AC2 workspace limit and billing upgrade, member/webhook limits and plan lowering (`[CR1-L]`), AC6 org bucket |
   | `cr1-webhooks.test.ts` | 3 | AC7 org webhook ordering, org events, digest `data.organizations` |
   | `cr1-legacy-migration.test.ts` | 4 | AC1 migration of a v1 dataset (legacy, see below) |
   | `cr2-ids.test.ts` | 10 | UUIDv7 everywhere incl. payloads, emails, headers, dedupe keys (`[CR2-U]`); timestamp = application clock (`[CR2-T]`); AC4 same-millisecond paging; AC2 on a fresh database; idempotency and cursors with UUIDs |
   | `cr2-legacy-ids.test.ts` | 12 | AC1 legacy read path, AC2, AC3 sunset, AC5 `legacy_ids`, AC6 legacy filters, backfilled UUID timestamps, pre-migration cursors and idempotency records (legacy) |
   | `cr3-audit.test.ts` | 12 | AC1 update entry, `PATCH {}`, AC2 no entry for replays/4xx, AC3 removal entries, AC4 visibility, every mutation (`[CR3-M]`), filters and cursors (`[CR3-F]`), org and personal audit (`[CR3-S]`), AC9 request ids and p99 |
   | `cr3-worker.test.ts` | 2 | AC5 system `deliver` entries and secret redaction, system `send` entries |
   | `cr3-retention.test.ts` | 2 | AC6 retention purge and stats |
   | `cr3-paging.test.ts` | 1 | AC7 paging under writes |
   | `cr3-export.test.ts` | 3 | AC8 export (plus a worker-kill variant that needs the worker commands), export permissions |

   Totals: CR-1 35, CR-2 22, CR-3 20; a full run is 692 + 35 (CR-1), + 57 (CR-2), + 77 (CR-3).

3. **Reports per CR**: `summary.cr` is the mode, `summary.byCr` has `v1` and one entry per delivered CR, CR
   categories (`CR-1`…) appear in `byCategory`, and the CR trap ids join `byTrap`.

### Acceptance smoke subset per CR

The 13 smoke walkthroughs must pass after each CR under the adapted calls:

```bash
SUITE_CR=CR-N TASKWELL_BASE_URL=http://127.0.0.1:8080 scripts/run.sh <abs dir>/acceptance-crN tests/smoke.test.ts
```

Accepted means 13/13 `[SMOKE-n]` pass. Under `CR-2`+, `[SMOKE-1]` checks a UUIDv7 user id and `[SMOKE-11]` a
UUIDv7 `X-Taskwell-Delivery-Id`.

### Legacy dataset (migration tests)

CR-1 acceptance criterion 1 and most of CR-2 are about data that existed **before** `./bin/setup` migrated it,
which no test can create through the new build. They read a dataset seeded on the previous build:

1. Start the **phase-1 accepted build** (`base_sha`) on a fresh database in test mode with its workers, then
   `cd lab/suite && TASKWELL_BASE_URL=… SUITE_CR=none node scripts/seed-legacy.ts <run dir>/legacy-manifest.json`
   (it resets that database first). Seeding on `none` serves the CR-1 and CR-2 legacy tests at every later CR,
   because each build's setup applies every migration up to its CR.
2. Stop it, check out the measured commit, run `./bin/setup` **twice** on the same database (idempotency), start
   one API and two workers as usual.
3. Run the suite with `SUITE_LEGACY_MANIFEST=<run dir>/legacy-manifest.json` within **24 hours** of seeding (the
   pre-migration idempotency record must still be live). `run.sh` runs `tests/cr*-legacy-*.test.ts` first, in a
   separate node invocation, before any test resets the database, and merges both invocations into one
   `results.json` (the first one is kept as `legacy-results.json`). The CR-2 legacy file moves the application
   clock past the sunset at its end.

Without the manifest the legacy tests are `skip` ("needs SUITE_LEGACY_MANIFEST"). A legacy file for CR-N also skips
when the dataset was seeded at CR-N or later.

The dataset: Ana owns Alpha (11 members including Dee as admin and Cy, 3 inactive webhooks, so above the free
limits) and Beta (Cy); Bo owns Gamma (Dee); projects, tasks (some assigned to Cy and Dee), a comment, one
idempotent task create and one tasks cursor. The manifest records every id, key and `created_at`.

## Results format

`results.json`:

```jsonc
{
  "generatedAt": "…", "complete": true, "baseUrl": "…",
  "passRateDefinition": "passed / (passed + failed); skipped and todo tests are excluded",
  "summary": {
    "cr": "none",                                            // SUITE_CR of the run
    "byCr": {"v1": {…}, "CR-1": {…}},                       // per suite, for every delivered CR
    "totals": {"total", "passed", "failed", "skipped", "passRate"},
    "kinds": {"happy": {…}, "trap": {…}, "errors": {…}},   // smoke vs TRAPS vs endpoint-error coverage
    "byCategory": {"A": {…}, …, "L": {…}, "smoke": {…}, "errors": {…}, "CR-1": {…}},
    "byTrap": {"A1": {…, "verdict": "pass|partial|fail|skipped|uncovered"}, …, "CR1-1": {…}},
    "uncoveredTraps": []
  },
  "harnessErrors": [],          // a test file that crashed outside any test
  "tests": [{"name", "file", "trapId", "trapIds", "category", "suite", "kind", "status", "durationMs", "message",
             "diagnostics", "classification"}]   // suite: "v1" | "CR-1" | "CR-2" | "CR-3"
}
```

`classification` is present, and `null`, on every failed trap test, for a human or agent to fill with
`not_implemented | wrong | untested_but_works | caught_by_own_tests` after reading `message` and `spec.log`. `diagnostics` carries notes a test
emits for reviewers (the L-row tests report which documented-consistent behaviour they observed; L2 asks the
reviewer to check the candidate README when it accepted a deferred restore).

Re-render the table after editing classifications: `node reporter/render-md.ts results.json results.md`.

## Test naming and categories

| Name prefix | Category | Kind |
|---|---|---|
| `[SMOKE-n]` | `smoke` — the 13 SMOKE.md walkthroughs | happy |
| `[A1]` … `[K1]` | TRAPS row; category = letter | trap |
| `[L1]` `[L2]` `[L3]` | controlled ambiguities: accept any documented-consistent behaviour, fail on the named failure mode | trap |
| `[ERR]` | every endpoint with each documented error status | errors |
| `[CR1-2]` … `[CR3-9]` | PHASE2 acceptance criterion N of that CR; category `CR-N`, trap id `CRn-N` | trap |
| `[CR1-R]`, `[CR2-U]`, `[CR3-M]`, … | a failure-mode probe from the CR's Specification (letter ids, titles in `reporter/model.ts` `CR_TRAPS`) | trap |
| `[CR1-H]` | CR endpoint happy path; category `CR-1`, no trap id | happy |

Every CR test has `suite: "CR-N"` and a category starting with `CR`, which is how the harness tells v1 regressions
apart (`harness/lib/score.ts` `isV1`). v1 test names never change between modes.

## Layout

```
lib/        client.ts (HTTP client, auth, idempotency/etag helpers, cursor pager), http.ts (raw fetch), fixtures.ts,
            clock.ts, receiver.ts (webhook receiver + HMAC check), testmode.ts (reset/drain/tick/emails/jobs),
            assert.ts, endpoints.ts (endpoint catalog used by 401/404/D1 matrices), suite.ts, worker.ts, env.ts,
            cr-mode.ts + cr.ts (SUITE_CR parsing, crTest, obsoleteIn), cr-adapter.ts (CR-1 call adaptation),
            ids.ts (opaque ids, UUIDv7 checks), orgs.ts (organization fixtures), audit.ts (audit fixtures),
            legacy.ts (legacy manifest)
tests/      smoke, errors-*, a-… l-* (one file per TRAPS category), cr1-*, cr2-*, cr3-* (phase 2)
reporter/   scoring.ts (custom node:test reporter → results.json), render-md.ts, model.ts
scripts/    run.sh, selftest.sh, seed-legacy.ts
stub/       server.ts — implements only /healthz and POST /__test/reset (501 elsewhere) for the self-test
```

## Self-test without a candidate

```bash
pnpm install && pnpm typecheck
pnpm selftest            # starts the stub, runs scripts/run.sh against it into out/selftest/
SUITE_CR=CR-3 pnpm selftest   # every mode: out/selftest-cr-1/ … out/selftest-cr-3/
```

Against the stub every test fails or is skipped, except the few that only need `/healthz` and
`POST /__test/reset` (2 in every mode). A test that passes against the stub is vacuous and must be fixed.

## Not covered by black-box tests

- `503 database_unavailable` and `500 internal_error` (cannot be provoked over HTTP).
- `POST /__test/seed` success and the 14.2 performance targets on the reference dataset (minutes of seeding;
  run separately). F4 checks only that a black-hole receiver does not slow task creation.
- Memory limits, startup time, SIGTERM behaviour, logging content (13.1–13.3).
- Phase 2: the CR-2 "reference dataset within 10 minutes" migration time and the CR-3 p99 on the reference
  dataset (perf harness; `[CR3-9]` only checks p99 on a small database), `422 export_too_large` (needs 1,000,000
  entries), and re-running `./bin/setup` (the operator runs it twice; the legacy tests then check nothing was
  duplicated).
