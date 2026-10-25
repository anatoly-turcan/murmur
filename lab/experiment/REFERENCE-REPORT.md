# Reference adjudication (sealed during the experiment)

Date: 2026-10-24. Adjudicator pass over the lab's reference implementation (`reference`) against the
hidden suite (`suite`, 692 `node:test` tests) and SPEC.md v1.0.

## Inputs

| Item | Value |
|---|---|
| Full run used | `reference-out/round1/suite/results.json` (generated 2026-10-24T10:32:09Z, `complete: true`) |
| Totals | 692 total, 692 passed, 0 failed, 0 skipped (G1/G3 ran with worker stop/start commands) |
| By kind | happy 13/13, trap 217/217, errors 462/462 |
| Disputes | `reference/DISPUTES.md` — no entries |
| Cross-checks | `experiment/TRAPS.md`, `experiment/SPEC-REVIEW-CHECKLIST.md`, suite `README.md`, `lib/*.ts`, `suite/out/selftest/results.json` |

## 1. Verdicts on failing tests

There are no failing tests and no disputed tests, so there is nothing to adjudicate as `SUITE_BUG`, `REF_BUG`,
`SPEC_GAP` or `UNVERIFIABLE`.

| Test | Verdict | Fix |
|---|---|---|
| — | — | — |

The three planted ambiguities (TRAPS L1–L3) are handled by tests that accept any documented-consistent behaviour
and fail only on the named failure mode; the reference's choices are recorded in its README and surfaced by the
suite diagnostics:

| Row | Reference behaviour (README "Assumptions") | Suite diagnostic | Consistent with SPEC? |
|---|---|---|---|
| L1 | one digest per local date in the timezone current at evaluation time; dedupe key as specified | Tokyo→LA: 0 extra digests; LA→Tokyo: 2026-05-10 digest sent early (current-zone rule) | yes (10.2 never sends two digests for one date) |
| L2 | restore of a task whose project is deleted → `410 gone` | "restore refused with 410 gone" | yes: 6.3 allows `410` for an object that "belongs to a soft-deleted parent"; only the restored object's own deleted state is exempt. TRAPS prefers `409 parent_deleted`, but `410` is a documented, non-leaking refusal and the test accepts it |
| L3 | fingerprint is method + path + canonical parsed body → `422 idempotency_key_reused` | "path is part of the fingerprint" | yes (TRAPS' recommended resolution) |

## 2. Sampled-test audit

Sampling: seeded (`random.Random(20261024)`) over the 692 passing tests, one per file first (23 files), then 17
more uniformly at random. For each test the assertions were compared with the SPEC clause they claim to cover.
"Adequate" means the test asserts at least what SPEC requires for the behaviour it names; notes record anything
weaker, stricter or only partially covered.

| # | File | Test | SPEC | Asserts | Audit |
|---|---|---|---|---|---|
| 1 | a-concurrency | [A3] replay returns the stored response and produces no new activity, email or delivery | 6.5 | 201 + `Idempotent-Replayed: true`, byte-identical body and ETag, activity count unchanged, exactly 1 `task_assigned` email, 1 receiver request, 1 delivery, 1 task | adequate |
| 2 | a-concurrency | [A5] 20 concurrent identical creates with one key create exactly one task | 6.5 | ≥1 `201`, every non-201 is `409 idempotency_in_progress`, all 201s carry one id, exactly one task listed, later replay returns that id | adequate (TRAPS A5 allows "any mix") |
| 3 | b-time | [B1] digest at 08:00 Australia/Sydney on the day daylight saving ends | 10.2 | 2026-04-04T21:30Z (07:30 AEST after the 16:00Z fall-back) → none; 22:00Z → exactly `['2026-04-05']` with subject, dedupe key, date, timezone, section shapes | adequate; an implementation using the still-DST offset would send at 21:00Z and fail step 1 |
| 4 | c-pagination | [C1] due_date paging is stable with many shared due dates | 6.4 | 50 tasks (15 distinct Nov dates, 20 sharing 2026-12-01, 15 null); after page 1 creates 5 tied tasks and deletes 3 in later pages; every surviving task appears exactly once | adequate |
| 5 | d-authorization | [D1] non-member POST /v1/workspaces/{ws}/restore → 404 indistinguishable from nonexistent | 5.1, 6.3 | outsider on real id and on ghost id both `404 not_found`, bodies equal after digit-normalisation, no object changed | adequate |
| 6 | e-soft-delete | [E1] 20 concurrent registrations of one email (mixed case) yield exactly one user | 3.1, 3.11 #4 | exactly one `201`, others `409 email_taken` | adequate |
| 7 | e-soft-delete | [E1] project slug is unique only among non-deleted projects | 3.5, 7.5 | recreate after delete → 201; restore first → `409 slug_taken`; first still `410`; delete second, restore first → 200 with slug | adequate |
| 8 | errors-auth | [ERR] GET /v1/workspaces/{ws}/tasks → 401 unauthenticated / invalid_api_key | 4, 6.3 precedence | no header → `401 unauthenticated`; unknown key → `401 invalid_api_key` (ids may not exist: 401 precedes 404) | adequate |
| 9 | errors-auth | [ERR] PATCH /v1/tasks/{task} → 401 unauthenticated / invalid_api_key | 4 | same pattern with a body | adequate |
| 10 | errors-comments-activity-search | [ERR] GET /v1/workspaces/{id}/activity → 400 invalid_query (since=notatime) | 6.1, 7.8 | `400 invalid_query` | adequate |
| 11 | errors-comments-activity-search | [ERR] POST /v1/comments/{id}/restore → 403 forbidden (member non-author) | 5.2 | admin deletes; non-author member and viewer restore → `403 forbidden` | adequate |
| 12 | errors-gone | [ERR] GET /v1/projects/{id}/summary → 410 gone (workspace deleted) | 6.3, 7.5 | owner and member → `410 gone`; outsider → `404 not_found` | adequate |
| 13 | errors-gone | [ERR] GET /v1/projects/{id}/tasks → 410 gone (workspace deleted) | 6.3, 7.6 | same triple | adequate |
| 14 | errors-gone | [ERR] GET /v1/workspaces/{id}/members → 410 gone (workspace deleted) | 6.3 | same triple | adequate |
| 15 | errors-gone | [ERR] GET /v1/workspaces/{id}/projects → 410 gone (workspace deleted) | 6.3 | same triple | adequate |
| 16 | errors-http | [ERR] DELETE /v1/comments/{id} → 400 invalid_header (malformed If-Match) | 6.6 | `1`, `W/"1"`, `*` each → `400 invalid_header`; object still `200` afterwards (self-healing restore only after the check is captured) | adequate |
| 17 | errors-http | [ERR] GET /v1/workspaces → 400 invalid_query (unknown parameter) | 6.1 | `?colour=blue` → `400 invalid_query` | adequate |
| 18 | errors-http | [ERR] GET /v1/workspaces/{ws}/search → 400 invalid_query (unknown parameter) | 6.1 | `?q=login&colour=blue` → `400 invalid_query` (q present, so the unknown parameter is what is rejected) | adequate |
| 19 | errors-http | [ERR] POST /v1/tasks/{task}/comments → 422 invalid_type (JSON array body) | 6.1 | `[]` → `422 validation_failed` with detail `{path: "", code: invalid_type}` | adequate |
| 20 | errors-http | [ERR] POST /v1/workspaces/{ws}/projects → 415 unsupported_media_type | 6.1 | valid JSON sent as `text/plain` → `415` | adequate |
| 21 | errors-http | [ERR] POST /v1/workspaces/{ws}/transfer-ownership → 415 unsupported_media_type | 6.1 | same on a non-creation POST with a body | adequate |
| 22 | errors-http | [ERR] PUT /v1/tasks/{id} → 405 method_not_allowed | 6.3 | `405 method_not_allowed` in error format | adequate |
| 23 | errors-notfound | [ERR] GET /v1/workspaces/{ws}/tasks → 404 not_found (nonexistent id) | 6.3 | member on id 987654321 → `404 not_found` | adequate |
| 24 | errors-projects-tasks | [ERR] POST /v1/projects/{id}/tasks → 422 invalid_date (2026-02-30) | 7.6 | detail `due_date` / `invalid_date` | adequate |
| 25 | errors-test-endpoints | [ERR] DELETE /__test/clock → 204 and real time resumes | 13.4 | override to 2030, `DELETE` → 204, `GET` → `overridden: false`, `now` within 60 s of real time | adequate |
| 26 | errors-test-endpoints | [ERR] POST /__test/clock/advance → 422 out_of_range (negative seconds) | 13.4 | `{seconds: -1}` → `422` detail `seconds` / `out_of_range`; clock unchanged | adequate; note: SPEC names the code but not the path, so `path: "seconds"` is slightly stricter than the text (it is the only field, so no realistic team is harmed) |
| 27 | errors-test-endpoints | [ERR] POST /__test/jobs/drain → 200 with counters | 13.4 | empty database: `drained: true`, integer `pending`/`running`/`dead`, pending and running 0 | adequate for a shape test; blocking semantics are exercised by `drainAll()` in every F/G/B test |
| 28 | errors-users | [ERR] PATCH /v1/users/me → 422 invalid_type (digest_enabled "yes") | 3.1, 7.2 | detail `digest_enabled` / `invalid_type` | adequate |
| 29 | errors-users | [ERR] POST /v1/users/me/api-keys → 422 too_many_items (21st active key) | 4, 7.2 | 19 extra keys succeed (20 active), 21st → `422` detail `path: ""`, `too_many_items`; revoking one frees a slot | adequate |
| 30 | errors-webhooks | [ERR] PATCH /v1/webhooks/{id} → 422 invalid_url | 7.10 | `mailto:` → detail `url` / `invalid_url` | adequate |
| 31 | errors-workspaces | [ERR] POST /v1/workspaces/{id}/members → 409 already_member | 7.4 | `409 already_member` | adequate |
| 32 | errors-workspaces | [ERR] POST /v1/workspaces/{id}/members → 410 gone | 6.3 | adding to a deleted workspace → `410 gone` | adequate |
| 33 | f-webhooks | [F6] deleting an endpoint removes it and its pending deliveries are never attempted | 7.10, 8.3 | 3 deliveries blocked behind a 500; delete → endpoint, list and single delivery `404`; +7 h drain → receiver still has 1 request; no due `webhook_delivery` job pending | adequate |
| 34 | g-side-effects | [G4] an endpoint that refuses connections dies alone while healthy deliveries keep flowing | 12, 8.3 | healthy endpoint receives every delivery promptly through the full 30s…6h schedule; refused delivery `dead` with 6 `error` attempts; only `webhook_delivery` jobs dead; no due pending job | adequate |
| 35 | h-numbers | [H1] output amount uses the currency decimals and amount_minor is a digit string | 3.7 | KWD/USD/JPY/BHD/EUR inputs → exact `{currency, amount, amount_minor}` on create and GET; `*_minor` strings | adequate |
| 36 | i-validation | [I1] email uniqueness is case-insensitive | 3.1 | register, then upper-case → `409 email_taken` | adequate (minimal, but exactly the clause) |
| 37 | j-rate-limit | [J1] key general bucket: 120 non-workspace requests per key per minute | 6.8 | 120 × `GET /v1/users/me` all 200, `RateLimit-Limit: 120` on the last; 121st → `429` with `Retry-After: 60`, `Remaining: 0`, `Reset: 60` | adequate |
| 38 | k-search | [K1] viewers may search; non-members get 404; q shorter than 2 characters is 400 | 11, 5.2 | viewer gets 4 results; outsider `404`; `a`, `  a  `, 101 chars → `400 invalid_query`; 100 chars → `200 []` | adequate |
| 39 | l-ambiguities | [L3] same Idempotency-Key and body on a different project is not replayed | 6.5, TRAPS L3 | never `Idempotent-Replayed`; accepts `422 idempotency_key_reused` or a fresh `201` in project 2; project 1 keeps exactly one task | adequate (controlled ambiguity by design) |
| 40 | smoke | [SMOKE-10] soft delete and restore | SMOKE.md 10, 7.6 | delete → 204; `410 gone`; absent from list; restore → 200 with `deleted_at: null`; listed again | adequate for a happy path; version bump and `task.deleted`/`task.restored` events are covered by A2 and F3 |

### Vacuous tests

None of the 40 sampled tests is vacuous: each one fails against the suite stub and asserts the behaviour SPEC
requires for the clause it names.

Independent cross-check: the suite's own stub self-test (`suite/out/selftest/results.json`, 692 tests)
passes exactly two tests, `[ERR] GET /healthz → 200 without authentication` and `[ERR] POST /__test/reset → 204`,
both of which test precisely what the stub implements. No other test passes without a real implementation.

## 3. Observations (non-blocking)

- `[ERR] POST /__test/clock/advance → 422 out_of_range` pins the detail path to `seconds`; SPEC 13.4 only names the
  code. Harmless, but if a team ever disputes it, relaxing to `expectError(res, 422, 'validation_failed')` plus a
  check that some detail has `code: 'out_of_range'` would match the text exactly.
- `[F4] the delivery is listed as soon as the request returns…` only requires the create to finish under the
  1,000 ms receiver timeout; the companion `[F4] a black-hole receiver does not slow task creation` enforces the
  14.2 numbers (p99 ≤ 150 ms, growth < 20 ms), so the pair is adequate.
- The reference answers L2 with `410 gone` rather than TRAPS' preferred `409 parent_deleted`. Both are documented
  refusals that never leak a `200`-then-`410`, and SPEC 6.3 explicitly permits `410` for a child of a soft-deleted
  parent, so no change is required; reviewers reading L2 diagnostics should treat `409`, `410` and a documented
  deferred restore as all acceptable.
- Error-matrix files (`errors-http`, `errors-notfound`, `d-authorization` D1) derive their cases from
  `lib/endpoints.ts`; any new endpoint added to SPEC must be added there or it silently escapes the 401/404/D1
  matrices.

## Phase 2

Date: 2026-10-24. Adjudicator pass over the reference after CR-1..3 (`feat(reference): CR-3`) against the
suite in `SUITE_CR` modes (`test(suite): phase 2 CR-1..3 tests and SUITE_CR modes`) and PHASE2.md.

### Inputs

| Item | Value |
|---|---|
| Full CR-3 run | `reference-out/CR-3/suite/results.json` (2026-10-24T12:19:03Z, `complete: true`): 769 total, 750 passed, 2 failed, 17 skipped (v1 689/2/1, CR-1 31/0/4, CR-2 10/0/12, CR-3 20/0/0) |
| Earlier modes | `CR-1/suite` 727: 721/1/5; `CR-2/suite` 749: 730/2/17; legacy runs `CR-1-legacy` 4/4, `CR-2-legacy` 16/16, `CR-3-legacy` 16/16 |
| Single-file runs | `CR-3-cr3` (33: 30/3), `CR-3-flake` (12: 11/1), `CR-3-recheck` (56: 54/2), `CR-3-f` 16/16, `CR-3-f2` 56: 55/1 |
| Adjudicator reruns | `reference-out/adjudicator/f2-1..5` (`f-webhooks.test.ts`, 5 × 16/16) and `adjudicator/cr3-audit` (`cr3-audit.test.ts` alone, 11/12: `[CR3-2]` `9 !== 8`), port 8190, all processes stopped |
| Disputes | `reference/DISPUTES.md`: three entries (charset test, `[SMOKE-3]`, `[CR3-2]`) |
| Stub self-test | `suite/out/selftest-cr-{1,2,3}/results.json`: 2 passes in every mode (`GET /healthz`, `POST /__test/reset`), as in v1 |

### 1. Verdicts on failing tests

Every test that failed in any CR-mode run directory, including the one that failed once in a recheck.

| Test | Where it fails | Verdict | Fix |
|---|---|---|---|
| `errors-http.test.ts` — `[ERR] POST /v1/workspaces → 201 with application/json; charset=utf-8` | every `CR-1`+ run (`422 validation_failed`, `organization_id` `required`) | **SUITE_BUG** | The test sends its body as `rawBody: JSON.stringify({ name })`, and `lib/cr-adapter.ts` `injectOrganization` only rewrites a plain-object `body`, so this is the one v1 workspace creation that reaches the candidate without `organization_id`, which PHASE2 CR-1 criterion 8 says every v1 call gets. The 422 is the behaviour CR-1 requires. Minimal fix in `injectOrganization`: when `opts.body` is not a plain object but `opts.rawBody` is a string, `opts.contentType` is absent or starts with `application/json`, and `JSON.parse(opts.rawBody)` is a plain object without `organization_id`, return `{ opts: { ...opts, rawBody: JSON.stringify({ ...parsed, organization_id: orgId }) }, orgId }` (keep `contentType`; leave unparseable, non-object and non-JSON raw bodies untouched so the 400/415/422 raw-body tests keep their meaning). |
| `smoke.test.ts` — `[SMOKE-3] welcome email` | every `CR-2`+ run | **SUITE_BUG** | SPEC 9.2 makes the last dedupe-key segment the activity event id, which under CR-2 is a UUIDv7 ("every `id` and every `*_id` … becomes a UUIDv7"). The walkthrough keeps the v1 `\d+`, while `[CR2-U] email dedupe keys embed the UUIDs of the objects they name` asserts `[0-9a-f-]{36}` for the same segment, so no build can pass both. Because the 13 walkthroughs gate CR acceptance (EXPERIMENT 5.3 step 4), this would block every team at CR-2. Minimal fix (`idPattern` is already imported): `assert.match(e.dedupe_key, new RegExp(`^member_added:${ws.id}:${userId}:${idPattern().source.slice(1, -1)}$`));`. |
| `cr3-audit.test.ts` — `[CR3-2] an idempotent replay and rejected requests add no entries` | file run alone: 4/4 for the reference author (`9 !== 6`), 1/1 for me (`9 !== 8`); passes in the full run | **SUITE_BUG** | `auditTeam()` adds three members, which enqueues three `member_added` emails; PHASE2 CR-3 says email sends are worker-originated mutations audited as `send` entries, and `[CR3-5] emails sent by the worker are audited…` reads them from the same workspace audit. `count()` counts every entry of the workspace audit without draining first, so the result depends on how many of the three sends the worker commits before `baseline` versus after it (I saw a 1/2 split, the author a 0/3 split). Nothing replayed or rejected wrote an entry in any run. Minimal fix: `import { drainAll } from '../lib/testmode.ts';` and `await drainAll();` immediately before `const baseline = await count();`. This keeps the strongest form of the assertion (no entry of any kind) and accepts both scopings of `send` entries (workspace-scoped or unscoped). |
| `cr3-audit.test.ts` — `[CR3-M] every workspace mutation writes one entry with the right action and resource` | `CR-3-cr3` run, before the reference changed transfer behaviour (`422 validation_failed`, `user_id` `not_org_member`); passes since | **SPEC_GAP** | The final transfer goes to `t.admin`, who is a workspace admin but not an organization member. PHASE2 CR-1 says only "A workspace owner must be an org member", and its role table reserves adding org members to `org_owner`/`org_admin`; rejecting the transfer and enrolling the target are both consistent readings, and `[CR1-O] a workspace owner is always an org member` deliberately accepts both. The suite's own CR-1 adapter encodes the rejecting reading (it enrolls transfer targets before v1 transfers), so `[CR3-M]` contradicts the suite's own assumption. Relaxation that accepts every reading without weakening the audit assertion: before the transfer add `await addOrgMember(t.owner, t.org.id, t.admin, 'org_member');` (`addOrgMember` is already imported). The reference's new behaviour (`src/features/workspaces/transfer.ts:32` enrolls whenever the target is not an org member) is acceptable only when the requester may add org members; it currently enrolls for any workspace owner, which lets an `org_member` grow the organization. Once the test is fixed the reference should either go back to `422 not_org_member` or restrict the auto-enrol to `org_owner`/`org_admin` requesters and update its README. |
| `f-webhooks.test.ts` — `[F2] per-endpoint ordering: a retrying delivery blocks later ones; other endpoints are independent` | once, `CR-3-recheck` ("endpoint B receives all five in creation order": B had 2 of 5 after `drainAll()` returned `drained: true, pending: 0, running: 0`); passed in the full run, in 3 + 5 reruns of the file | **REF_BUG** | Not environmental: the failed test took 154 ms in total, and endpoint B answers after 50 ms, so a receiver timeout (1,000 ms) is impossible and only two of B's five serialised deliveries could have completed when drain returned. `src/jobs/claim.ts` `countDue` reads `pending` and `running` in two separate autocommit statements (WAL, each its own snapshot): if the pending count runs while B's delivery 2 is `running` (delivery 3 is then blocked and not counted), the worker commits delivery 2, and the running count then sees 0, drain reports `drained: true` with three due deliveries left. `/__test/jobs/drain` polls every 25 ms, so the window is hit rarely (about 1 in 10 F2 runs so far). Fix: take both counts in one snapshot, e.g. one statement `SELECT (SELECT count(*) FROM jobs j WHERE j.status = 'pending' AND j.run_at <= ? AND <UNBLOCKED>) AS pending, (SELECT count(*) FROM jobs WHERE status = 'running') AS running, (SELECT count(*) FROM jobs WHERE status = 'dead') AS dead`, or wrap the three reads in one `BEGIN`/`COMMIT`. Any v1 test that drains behind a chain of serialised deliveries (F2, F5, F6, G4, CR1-7, SMOKE-11) can flake until this is fixed. |

The two disputes recorded before CR-3 are upheld as suite bugs; the `[CR3-2]` dispute is upheld with the fix the
author proposed (`drainAll()` before the baseline). The `[F2]` "probably environmental" note in the final report is
overturned: it is a reference race. No test is `UNVERIFIABLE`.

### 2. Sampled CR-test audit (25 passing tests)

Sampling: mulberry32 seeded with `20261024` over the 61 passing CR tests of the full CR-3 run (script in the
sampling script not published; the listing is reproducible from `results.json`). "Adequate" means the test asserts at least what the
PHASE2 clause it names requires and fails against the stub.

| # | Test | PHASE2 | Asserts | Audit |
|---|---|---|---|---|
| 1 | `[CR1-3] an org_member outside workspace W gets 404, as a non-member did in v1` | CR-1 role table | org_member outside W: tasks list, task read, search → `404 not_found` | adequate (negative half of AC3) |
| 2 | `[CR1-7] an org "*" webhook gets events of two workspaces in global creation order, one delivery in flight` | AC7 | first delivery fails and blocks the endpoint across workspaces; after +30 s all 7 in `[workspace_id, task.id]` creation order; `maxInFlight === 1`; no overlap; signed | adequate |
| 3 | `[CR1-EV] digest data.organizations lists the organizations whose tasks appear` | CR-1 "Activity and webhooks" | `[{id, name}]` of the one org with a due task; `[]` for an idle member | adequate; relies on SPEC 10.2 "sent even when all sections are empty" for the idle case |
| 4 | `[CR1-EV] the organization activity feed records org events; workspace feeds stay v1` | CR-1 event types | exactly one of each new type, newest first, actor of the removal, workspace feed free of org types | adequate; note: pins `org_member.added === 4` ("three fixture members plus one extra"), i.e. no event for the owner at creation, which PHASE2 does not state. Relax to `[4, 5].includes(counts.get('org_member.added'))` if a team emits one for the owner |
| 5 | `[CR1-H] organization slugs are unique among non-deleted organizations` | CR-1 model ("same rules as workspace slugs") | `409 slug_taken`; `ACME` → `422 invalid_format` (SPEC 3.3: no uppercase); slug free again after delete | adequate |
| 6 | `[CR1-O] a deleted organization is 410 for members and 404 for others until restored` | CR-1 endpoints + v1 6.3 | `409 not_deleted` before; member `410 gone`, stranger `404`; restore bumps version by two | adequate |
| 7 | `[CR1-O] ownership transfer leaves exactly one org_owner` | CR-1 role table | transfer to non-member is 4xx; after transfer exactly one `org_owner`, old owner demoted and `403` on delete | adequate |
| 8 | `[CR1-R] managing members: owner and admin yes; billing and member 403` | CR-1 role table | add by each role (201/201/403/403); PATCH/DELETE by billing and member `403`; admin can PATCH and DELETE | adequate |
| 9 | `[CR1-R] roles other than the four org roles are 422 invalid_enum` | CR-1 org roles | `superuser` → `422` `role`/`invalid_enum` | adequate (minimal) |
| 10 | `[CR2-4] two tasks created in the same millisecond have a deterministic order and page cleanly at limit=1` | AC4 | same `created_at`; order equals UUID byte order desc; repeatable; same on the workspace list | adequate |
| 11 | `[CR2-4] many same-millisecond tasks, created concurrently, page exactly once under every sort` | AC4 + ordering rule | 12 concurrent creates, distinct ids; every sort pages each once in UUID tie order | adequate |
| 12 | `[CR2-5] payloads of objects created after the migration use UUIDs and carry no legacy_ids` | AC5 | two payloads with UUID `task.id` and no `legacy_ids` key; email data too | adequate; AC5 says "absent", so a build emitting `legacy_ids: {}` fails, which the text supports |
| 13 | `[CR2-M] idempotent replays and cursors work with UUID ids` | CR-2 spec (replays, cursors) | reordered-key replay byte-identical with `Idempotent-Replayed`; cursor paging without repeats | adequate |
| 14 | `[CR2-T] a new UUIDv7 carries the application clock at creation in its timestamp` | CR-2 "timestamp component equals the application clock at creation" | user, key, workspace, project, webhook at T0; task, comment at T0+7 s; every event id = `occurred_at`; delivery id = `created_at`; email id = `sent_at`; org at T0+7 s | adequate, strict but literal |
| 15 | `[CR2-U] a malformed id in the path is 404` | CR-2 legacy read path (only plain integers resolve) | `not-a-uuid`, bad hex, `1.5` → `404`; real id still 200 | adequate |
| 16 | `[CR2-U] email dedupe keys embed the UUIDs of the objects they name` | CR-2 + SPEC 9.2 | `member_added` and `task_assigned` keys with UUID segments; `data.task_id`, `data.workspace_id` | adequate |
| 17 | `[CR2-U] every id and *_id in API responses is a lowercase UUIDv7 string` | CR-2 first bullet | 18 read endpoints, emails, payloads, delivery header equals `delivery_id` | adequate |
| 18 | `[CR2-U] organizations, members, sole_owner details and created objects all carry UUIDv7 ids` | CR-2 first bullet | org, workspace, org members, api key, `sole_owner.workspace_ids` | adequate |
| 19 | `[CR3-1] PATCH {} writes an entry with an empty diff whose snapshots differ only in version and updated_at` | CR-3 "A PATCH with {} writes an entry with an empty diff and version change only" | one user entry, `diff {}`, `after.version = before.version + 1`, snapshots equal minus `version`/`updated_at`/`overdue` | adequate |
| 20 | `[CR3-4] admins still read entries of a soft-deleted task and of a soft-deleted workspace` | AC4 | `['delete','create']` for the task; single read 200; workspace audit after workspace delete 200 with the delete entry; viewer still `403` | adequate |
| 21 | `[CR3-5] a delivery that succeeds on its second attempt yields two system deliver entries; the secret never appears` | AC5 | two `deliver` entries, `actor.type system`, `after.attempts` lengths `[1, 2]`, final `succeeded`; secret absent from workspace, org and personal audits; create entry redacted | adequate |
| 22 | `[CR3-6] after advancing 31 days and a scheduler tick, older entries are gone everywhere; newer ones stay` | AC6 | purged ids absent from all three endpoints and `404` singly; new entry present; `stats.entries === org audit length`, `oldest`, `retention_days`; resources untouched | adequate |
| 23 | `[CR3-8] the export still emails exactly once when the worker is killed mid-export and restarted` | AC8 (kill variant) | kill after 150 ms, restart, +60 s, drain; exactly one `audit_export_ready`; 10,000 NDJSON lines in range | adequate but timing-weak: a fast export may finish inside the 150 ms, in which case the test degenerates to the plain AC8 path. Not vacuous (it still proves exactly-once after a restart); a stronger version would kill as soon as `GET /__test/jobs?status=running` shows the export job |
| 24 | `[CR3-S] /v1/users/me/audit lists only my own actions in workspaces I still belong to` | CR-3 `/v1/users/me/audit` | only own actor, across two workspaces, entries of a left workspace disappear | adequate |
| 25 | `[CR3-S] audit stats follow the organization audit permissions` | CR-3 stats + visibility | owner 200, org_member `403`, non-member workspace admin `404` | adequate |

**Vacuous tests:** none. Every sampled test fails against the stub (`selftest-cr-3`: 2 passes of 769, the same two
as v1), and each asserts the clause it names.

### 3. v1-under-CR adjustments (15 sampled)

All v1 assertion changes in the phase-2 suite commit were read (`c-pagination`, `d-authorization`, `e-soft-delete`, `errors-*`,
`f-webhooks`, `j-rate-limit`, `k-search`, `l-ambiguities`, `smoke`, plus `lib/cr-adapter.ts`, `lib/ids.ts`).

| # | Adjustment | Under `SUITE_CR=none` | Under CR modes | Weakened? |
|---|---|---|---|---|
| 1 | `cr-adapter.ts`: `organization_id` injected into every v1 `POST /v1/workspaces` (steward-owned business org, creator `org_member`) | no-op | business plan: no member/workspace caps, 50 webhooks, 6000 req/min, creator has no org-level read rights, so D1/D2/E5/J1 premises hold | no; but it misses `rawBody` (verdict 1) |
| 2 | `cr-adapter.ts`: transfer target enrolled as `org_member` before v1 transfers | no-op | `[D5]` still demands exactly two workspace events (`org_member.added` is an org event) | no |
| 3 | `[L3] … different endpoint type` skipped from CR-1 | runs | `obsolete under CR-1` with reason; per-project `[L3]` keeps the trap | justified |
| 4 | `[C2] frozen clock … id desc` → `compareIdsDesc` | identical numeric sort | asserts the UUID byte-order rule CR-2 names | no |
| 5 | `[C2] members user_id asc; activity id desc` → `compareIds` | identical | same | no |
| 6 | `[C2]/[C1] dueKey` tie → `compareIds` | identical | same | no |
| 7 | `[D2]×4, [D5]` "events after a mark": `id > mark` → seen-set | equivalent | no longer assumes monotonic ids; still exact set equality on fresh `task.updated` events | no (slightly stronger) |
| 8 | `[D5]`, `[ERR] DELETE /v1/users/me → 409 sole_owner`: `workspace_ids` sort → `compareIds` | identical | same | no |
| 9 | `[E5] comments include_deleted` `[keep, drop]` → `byCreation([keep, drop])` | identical (ids ascend) | asserts SPEC "created_at asc, id asc" with UUID order | no |
| 10 | `[E5] workspaces include_deleted` → `idsAsc` | identical | same | no |
| 11 | `[ERR] GET /__test/jobs`: `typeof id === 'number'` → `assertTestEndpointId` | identical | accepts integer or UUIDv7 (jobs are not in CR-2's list) | relaxed only for an object CR-2 does not cover; justified |
| 12 | `[F2]` "delivery ids ascend with creation order" → distinct-only under CR-2 | identical | UUIDv7s minted in one frozen millisecond carry no mandated order; the delivery *order* assertions on task ids are unchanged | justified |
| 13 | `[J1] every response carries RateLimit headers`: `/v1/tasks/987654321` → `NONEXISTENT_ID` | identical | a valid-format UUIDv7 that does not exist, so the 404 is still a 404 and not a legacy-id path | no |
| 14 | `[K1] within a rank … id desc`: `[c, b, a]` → `idsDesc(a, b, c)`; `[a, c, b]` → `[a, ...idsDesc(b, c)]` | identical | asserts the tie rule with UUID order; `a` first after its update is still required | no |
| 15 | `[SMOKE-1]` `typeof user.id` → `assertPublicId`; `[SMOKE-11]` delivery id `/^\d+$/` → `idPattern()` and `idFromHeader` | identical | requires lowercase UUIDv7 | no (stronger) |

No v1 assertion was weakened. The two places where the adaptation is *missing* rather than weak are verdicts 1 and 2
above (`rawBody` injection, `[SMOKE-3]` pattern).

### 4. Observations (non-blocking)

- PHASE2 CR-3 does not say which audit a worker `send` entry belongs to. The reference scopes a welcome email to its
  workspace (and `[CR3-5]` relies on that); a team that leaves `workspace_id: null` on email entries would fail
  `[CR3-5] emails sent by the worker…`. If that happens, the relaxation is to read `send` entries from
  `/v1/organizations/{id}/audit` or `/v1/users/me/audit` as well before asserting; it is not needed for the reference.
- `[CR1-7] org webhooks receive org events; workspace events only with "*"` asserts exact event sequences; fine, but
  it also assumes `org_member.added` is the only event an `addOrgMember` call emits on the org hook.
- The reference's `X-Request-Id` on every response (not only mutating ones) and the fresh id on replays are both
  compatible with the tests (`[CR3-9]` checks distinctness on mutations only).
- The legacy dataset's 24-hour idempotency record expires around 2026-10-25T11:22Z; after that the legacy files need
  a re-seed on a build before the phase-2 adjudicated fixes, as the reference report says.
