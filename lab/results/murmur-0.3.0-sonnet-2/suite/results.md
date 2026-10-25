# Taskwell hidden suite results

Generated 2026-10-25T14:20:34.146Z against `http://127.0.0.1:8085`. Run complete: **yes**.

Pass rate = passed / (passed + failed); skipped and todo tests are excluded.

## Summary

| | Tests | Pass | Fail | Skip | Pass rate |
|---|---:|---:|---:|---:|---:|
| **Overall** | 692 | 672 | 20 | 0 | 97.1% |
| Happy path (smoke) | 13 | 13 | 0 | 0 | 100.0% |
| Traps (A–L, CR) | 217 | 200 | 17 | 0 | 92.2% |
| Endpoint errors | 462 | 459 | 3 | 0 | 99.4% |

## By suite (mode none)

| | Tests | Pass | Fail | Skip | Pass rate |
|---|---:|---:|---:|---:|---:|
| v1 | 692 | 672 | 20 | 0 | 97.1% |

## By category

| | Tests | Pass | Fail | Skip | Pass rate |
|---|---:|---:|---:|---:|---:|
| A — Concurrency | 22 | 22 | 0 | 0 | 100.0% |
| B — Time | 13 | 12 | 1 | 0 | 92.3% |
| C — Pagination | 9 | 9 | 0 | 0 | 100.0% |
| D — Authorization | 73 | 73 | 0 | 0 | 100.0% |
| E — Soft delete | 16 | 16 | 0 | 0 | 100.0% |
| F — Webhook delivery | 16 | 5 | 11 | 0 | 31.3% |
| G — Exactly-once side effects | 5 | 4 | 1 | 0 | 80.0% |
| H — Numbers | 13 | 13 | 0 | 0 | 100.0% |
| I — Input and validation | 23 | 21 | 2 | 0 | 91.3% |
| J — Rate limiting | 13 | 13 | 0 | 0 | 100.0% |
| K — Search | 9 | 9 | 0 | 0 | 100.0% |
| L — Controlled ambiguities | 5 | 3 | 2 | 0 | 60.0% |
| smoke — Smoke (happy path) | 13 | 13 | 0 | 0 | 100.0% |
| errors — Endpoint error coverage | 462 | 459 | 3 | 0 | 99.4% |

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
| B4 | partial | 3 | 2 | 1 | 0 |
| B5 | pass | 1 | 1 | 0 | 0 |
| C1 | pass | 3 | 3 | 0 | 0 |
| C2 | pass | 3 | 3 | 0 | 0 |
| C3 | pass | 3 | 3 | 0 | 0 |
| D1 | pass | 42 | 42 | 0 | 0 |
| D2 | pass | 5 | 5 | 0 | 0 |
| D3 | pass | 15 | 15 | 0 | 0 |
| D4 | pass | 3 | 3 | 0 | 0 |
| D5 | pass | 6 | 6 | 0 | 0 |
| D6 | pass | 2 | 2 | 0 | 0 |
| E1 | pass | 6 | 6 | 0 | 0 |
| E2 | pass | 2 | 2 | 0 | 0 |
| E3 | pass | 2 | 2 | 0 | 0 |
| E4 | pass | 3 | 3 | 0 | 0 |
| E5 | pass | 3 | 3 | 0 | 0 |
| F1 | fail | 2 | 0 | 2 | 0 |
| F2 | fail | 1 | 0 | 1 | 0 |
| F3 | partial | 4 | 3 | 1 | 0 |
| F4 | pass | 2 | 2 | 0 | 0 |
| F5 | fail | 1 | 0 | 1 | 0 |
| F6 | fail | 6 | 0 | 6 | 0 |
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
| I5 | partial | 3 | 2 | 1 | 0 |
| I6 | pass | 1 | 1 | 0 | 0 |
| J1 | pass | 13 | 13 | 0 | 0 |
| K1 | pass | 9 | 9 | 0 | 0 |
| L1 | pass | 2 | 2 | 0 | 0 |
| L2 | pass | 1 | 1 | 0 | 0 |
| L3 | fail | 2 | 0 | 2 | 0 |

## Failed tests (20)

| Test | Category | Classification | Message |
|---|---|---|---|
| [B4] every timestamp is UTC with milliseconds and Z, written from the frozen clock | B | _null_ | drain must report every due job done: {"drained":true,"pending":4,"running":0,"dead":0} + actual - expected { drained: true, + pending: 4, - pending: 0, running: 0 } |
| [ERR] POST /v1/workspaces/{id}/webhooks → 422 invalid_url (over 2048 chars) | errors |  | missing detail {"path":"url","code":"invalid_url"}: POST http://127.0.0.1:8085/v1/workspaces/1/webhooks → 422 {"error":{"code":"validation_failed","message":"The request body is invalid.","details":[{"path":"url","code":"too_long","message" |
| [ERR] POST /v1/workspaces/{id}/webhooks → 422 too_short (secret 31 chars) | errors |  | missing detail {"path":"secret","code":"too_short"}: POST http://127.0.0.1:8085/v1/workspaces/1/webhooks → 422 {"error":{"code":"validation_failed","message":"The request body is invalid.","details":[{"path":"secret","code":"invalid_format" |
| [ERR] POST /v1/workspaces → 422 too_long (slug with 51 characters) | errors |  | missing detail {"path":"slug","code":"too_long"}: POST http://127.0.0.1:8085/v1/workspaces → 422 {"error":{"code":"validation_failed","message":"The request body is invalid.","details":[{"path":"slug","code":"invalid_format","message":"Has  |
| [F1] retry schedule 30s/2m/10m/1h/6h on the application clock, then dead, then redeliver | F | _null_ | drain must report every due job done: {"drained":true,"pending":1,"running":0,"dead":0} + actual - expected { drained: true, + pending: 1, - pending: 0, running: 0 } |
| [F1] a redirect is not followed and counts as a failed attempt | F | _null_ | drain must report every due job done: {"drained":true,"pending":1,"running":0,"dead":0} + actual - expected { drained: true, + pending: 1, - pending: 0, running: 0 } |
| [F2] per-endpoint ordering: a retrying delivery blocks later ones; other endpoints are independent | F | _null_ | drain must report every due job done: {"drained":true,"pending":5,"running":0,"dead":0} + actual - expected { drained: true, + pending: 5, - pending: 0, running: 0 } |
| [F3] signed headers, identical body bytes across attempts, payload stored on the delivery | F | _null_ | drain must report every due job done: {"drained":true,"pending":1,"running":0,"dead":0} + actual - expected { drained: true, + pending: 1, - pending: 0, running: 0 } |
| [F5] a slow receiver times out once; no overlapping attempt until the retry is due | F | _null_ | drain must report every due job done: {"drained":true,"pending":1,"running":0,"dead":0} + actual - expected { drained: true, + pending: 1, - pending: 0, running: 0 } |
| [F6] redeliver is refused unless the delivery is dead | F | _null_ | drain must report every due job done: {"drained":true,"pending":1,"running":0,"dead":0} + actual - expected { drained: true, + pending: 1, - pending: 0, running: 0 } |
| [F6] redeliver of a dead delivery: 202, completed_at null, attempt_count keeps counting | F | _null_ | drain must report every due job done: {"drained":true,"pending":1,"running":0,"dead":0} + actual - expected { drained: true, + pending: 1, - pending: 0, running: 0 } |
| [F6] deleting an endpoint removes it and its pending deliveries are never attempted | F | _null_ | drain must report every due job done: {"drained":true,"pending":3,"running":0,"dead":0} + actual - expected { drained: true, + pending: 3, - pending: 0, running: 0 } |
| [F6] workspace deletion cancels pending deliveries; they stay cancelled after restore | F | _null_ | drain must report every due job done: {"drained":true,"pending":1,"running":0,"dead":0} + actual - expected { drained: true, + pending: 1, - pending: 0, running: 0 } |
| [F6] active:false stops new deliveries but pending ones continue | F | _null_ | drain must report every due job done: {"drained":true,"pending":1,"running":0,"dead":0} + actual - expected { drained: true, + pending: 1, - pending: 0, running: 0 } |
| [F6] deleting a project does not affect pending deliveries | F | _null_ | drain must report every due job done: {"drained":true,"pending":1,"running":0,"dead":0} + actual - expected { drained: true, + pending: 1, - pending: 0, running: 0 } |
| [G4] an endpoint that refuses connections dies alone while healthy deliveries keep flowing | G | _null_ | drain must report every due job done: {"drained":true,"pending":1,"running":0,"dead":0} + actual - expected { drained: true, + pending: 1, - pending: 0, running: 0 } |
| [I1] uppercase or malformed slugs are rejected | I | _null_ | missing detail {"path":"slug","code":"too_long"}: POST http://127.0.0.1:8085/v1/workspaces/1/projects → 422 {"error":{"code":"validation_failed","message":"The request body is invalid.","details":[{"path":"slug","code":"invalid_format","mes |
| [I5] precedence: 415 before 422, 404 before 400, 403 before 422, 410 before 422, 401 before 404 | I | _null_ | expected status 404 (not_found), got PATCH http://127.0.0.1:8085/v1/tasks/987654321 → 400 {"error":{"code":"malformed_json","message":"body is not valid JSON: Unexpected end of JSON input","details":[{"path":"","code":"invalid_json","messag |
| [L3] same Idempotency-Key and body on a different project is not replayed | L | _null_ | replaying a task of another project is the failure mode |
| [L3] same Idempotency-Key and body on a different endpoint type is not replayed | L | _null_ | returning the workspace for a project create is the failure mode |

## Diagnostics for reviewers

| Test | Status | Notes |
|---|---|---|
| [F4] a black-hole receiver does not slow task creation | pass | p99 without webhook 17.8 ms, with black-hole webhook 16.2 ms |
| [L1] Tokyo → Los Angeles mover never gets a second digest for the same date | pass | L1 Tokyo→LA: 0 new digest(s) at 08:00 PDT on 9 May |
| [L1] Los Angeles → Tokyo mover gets at most one digest per date and keeps receiving them | pass | L1 LA→Tokyo: 2026-05-10 digest sent early (current-zone rule) |
| [L2] restoring a task while its project is deleted is refused or deferred, never leaked | pass | L2: restore refused with 410 gone |
