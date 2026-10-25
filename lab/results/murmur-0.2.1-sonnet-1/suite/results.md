# Taskwell hidden suite results

Generated 2026-10-25T05:46:26.801Z against `http://127.0.0.1:8085`. Run complete: **yes**.

Pass rate = passed / (passed + failed); skipped and todo tests are excluded.

## Summary

| | Tests | Pass | Fail | Skip | Pass rate |
|---|---:|---:|---:|---:|---:|
| **Overall** | 692 | 687 | 5 | 0 | 99.3% |
| Happy path (smoke) | 13 | 13 | 0 | 0 | 100.0% |
| Traps (A–L, CR) | 217 | 213 | 4 | 0 | 98.2% |
| Endpoint errors | 462 | 461 | 1 | 0 | 99.8% |

## By suite (mode none)

| | Tests | Pass | Fail | Skip | Pass rate |
|---|---:|---:|---:|---:|---:|
| v1 | 692 | 687 | 5 | 0 | 99.3% |

## By category

| | Tests | Pass | Fail | Skip | Pass rate |
|---|---:|---:|---:|---:|---:|
| A — Concurrency | 22 | 22 | 0 | 0 | 100.0% |
| B — Time | 13 | 13 | 0 | 0 | 100.0% |
| C — Pagination | 9 | 9 | 0 | 0 | 100.0% |
| D — Authorization | 73 | 72 | 1 | 0 | 98.6% |
| E — Soft delete | 16 | 16 | 0 | 0 | 100.0% |
| F — Webhook delivery | 16 | 16 | 0 | 0 | 100.0% |
| G — Exactly-once side effects | 5 | 4 | 1 | 0 | 80.0% |
| H — Numbers | 13 | 13 | 0 | 0 | 100.0% |
| I — Input and validation | 23 | 22 | 1 | 0 | 95.7% |
| J — Rate limiting | 13 | 13 | 0 | 0 | 100.0% |
| K — Search | 9 | 9 | 0 | 0 | 100.0% |
| L — Controlled ambiguities | 5 | 4 | 1 | 0 | 80.0% |
| smoke — Smoke (happy path) | 13 | 13 | 0 | 0 | 100.0% |
| errors — Endpoint error coverage | 462 | 461 | 1 | 0 | 99.8% |

## By TRAPS row

| Id | Verdict | Tests | Pass | Fail | Skip |
|---|---|---:|---:|---:|---:|
| A1 | pass | 3 | 3 | 0 | 0 |
| A2 | pass | 8 | 8 | 0 | 0 |
| A3 | pass | 5 | 5 | 0 | 0 |
| A4 | pass | 1 | 1 | 0 | 0 |
| A5 | pass | 4 | 4 | 0 | 0 |
| A6 | pass | 1 | 1 | 0 | 0 |
| B1 | pass | 3 | 3 | 0 | 0 |
| B2 | pass | 3 | 3 | 0 | 0 |
| B3 | pass | 3 | 3 | 0 | 0 |
| B4 | pass | 3 | 3 | 0 | 0 |
| B5 | pass | 1 | 1 | 0 | 0 |
| C1 | pass | 3 | 3 | 0 | 0 |
| C2 | pass | 3 | 3 | 0 | 0 |
| C3 | pass | 3 | 3 | 0 | 0 |
| D1 | pass | 42 | 42 | 0 | 0 |
| D2 | pass | 5 | 5 | 0 | 0 |
| D3 | pass | 15 | 15 | 0 | 0 |
| D4 | pass | 3 | 3 | 0 | 0 |
| D5 | partial | 6 | 5 | 1 | 0 |
| D6 | pass | 2 | 2 | 0 | 0 |
| E1 | pass | 6 | 6 | 0 | 0 |
| E2 | pass | 2 | 2 | 0 | 0 |
| E3 | pass | 2 | 2 | 0 | 0 |
| E4 | pass | 3 | 3 | 0 | 0 |
| E5 | pass | 3 | 3 | 0 | 0 |
| F1 | pass | 2 | 2 | 0 | 0 |
| F2 | pass | 1 | 1 | 0 | 0 |
| F3 | pass | 4 | 4 | 0 | 0 |
| F4 | pass | 2 | 2 | 0 | 0 |
| F5 | pass | 1 | 1 | 0 | 0 |
| F6 | pass | 6 | 6 | 0 | 0 |
| G1 | pass | 1 | 1 | 0 | 0 |
| G2 | pass | 1 | 1 | 0 | 0 |
| G3 | pass | 2 | 2 | 0 | 0 |
| G4 | fail | 1 | 0 | 1 | 0 |
| H1 | pass | 8 | 8 | 0 | 0 |
| H2 | pass | 5 | 5 | 0 | 0 |
| I1 | partial | 12 | 11 | 1 | 0 |
| I2 | pass | 3 | 3 | 0 | 0 |
| I3 | pass | 1 | 1 | 0 | 0 |
| I4 | pass | 3 | 3 | 0 | 0 |
| I5 | pass | 3 | 3 | 0 | 0 |
| I6 | pass | 1 | 1 | 0 | 0 |
| J1 | pass | 13 | 13 | 0 | 0 |
| K1 | pass | 9 | 9 | 0 | 0 |
| L1 | pass | 2 | 2 | 0 | 0 |
| L2 | pass | 1 | 1 | 0 | 0 |
| L3 | partial | 2 | 1 | 1 | 0 |

## Failed tests (5)

| Test | Category | Classification | Message |
|---|---|---|---|
| [D5] 20 concurrent transfers leave exactly one owner | D | _null_ | exactly one transfer may succeed, got 200,200,200,200,200,200,200,200,200,403,403,403,403,403,403,403,403,403,403,403 9 !== 1 |
| [ERR] POST /v1/workspaces → 422 too_long (slug with 51 characters) | errors |  | missing detail {"path":"slug","code":"too_long"}: POST http://127.0.0.1:8085/v1/workspaces → 422 {"error":{"code":"validation_failed","message":"The request body is invalid.","details":[{"path":"slug","code":"invalid_format","message":"Must |
| [G4] an endpoint that refuses connections dies alone while healthy deliveries keep flowing | G | _null_ | after drain no pending job may be due + actual - expected + [ + { + attempt_count: 0, + id: 28, + last_error: null, + run_at: '2026-04-01T11:12:30.000Z', + status: 'pending', + type: 'webhook_delivery' + }, + { + attempt_count: 0, + id: 22, |
| [I1] uppercase or malformed slugs are rejected | I | _null_ | missing detail {"path":"slug","code":"too_long"}: POST http://127.0.0.1:8085/v1/workspaces/1/projects → 422 {"error":{"code":"validation_failed","message":"The request body is invalid.","details":[{"path":"slug","code":"invalid_format","mes |
| [L3] same Idempotency-Key and body on a different project is not replayed | L | _null_ | replaying a task of another project is the failure mode |

## Diagnostics for reviewers

| Test | Status | Notes |
|---|---|---|
| [F4] a black-hole receiver does not slow task creation | pass | p99 without webhook 13.0 ms, with black-hole webhook 13.3 ms |
| [L1] Tokyo → Los Angeles mover never gets a second digest for the same date | pass | L1 Tokyo→LA: 0 new digest(s) at 08:00 PDT on 9 May |
| [L1] Los Angeles → Tokyo mover gets at most one digest per date and keeps receiving them | pass | L1 LA→Tokyo: 2026-05-10 digest sent early (current-zone rule) |
| [L2] restoring a task while its project is deleted is refused or deferred, never leaked | pass | L2: restore refused with 410 gone |
| [L3] same Idempotency-Key and body on a different endpoint type is not replayed | pass | L3: path is part of the fingerprint (422 idempotency_key_reused) |
