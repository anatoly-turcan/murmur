# Taskwell SPEC/SMOKE review — round 1 (independent reviewer, 2026-10-24)

Reviewer read SPEC.md, SMOKE.md and SPEC-REVIEW-CHECKLIST.md; did not open TRAPS.md. Line numbers refer to the SPEC.md draft under review unless marked SMOKE; the edits were applied before the freeze.

## Category 1: Stack neutrality / architecture nudging

1.1 L17 — "The system must run on a single machine with one API process and one or two worker processes sharing one relational database." Favours single-process runtimes. Proposed: "The system must run on a single machine against one relational database. `./bin/api` may use any number of OS processes or threads; `./bin/worker` may be run as one or two instances."
1.2 L773 — "Memory of the API process below 512 MiB, worker below 512 MiB" assumes one process per role. Proposed: "Total resident memory of everything started by `./bin/api` stays below 512 MiB, and of each `./bin/worker` instance below 512 MiB, under the load above."
1.3 L15 — "…is executed by a separate worker process that reads jobs from the database." Prescribes a polling-worker design. Proposed: "Everything asynchronous (webhook delivery, emails, digests, reminders) is carried out by the worker, started separately with `./bin/worker`; API requests never wait for it."
1.4 L686 — "…executed by the worker from a jobs table … There is no in-process queue…" Implementation nouns. Proposed: "The database is the only shared infrastructure; no other server (cache, broker) may be required. Work accepted by the API is carried out even if the worker starts only afterwards or restarts in between." If the jobs-table design is a hard constraint, state it explicitly as a constraint.
1.5 L560 — "Deliveries are created in the same database transaction as the activity event…" Not checkable over HTTP. Proposed: "A delivery is listed by `/v1/webhooks/{id}/deliveries` as soon as the request that caused it has returned; that request never contacts a receiver."
1.6 L629 — "Emails are produced by the worker from jobs created in the same transaction…" Proposed: "Emails are written by the worker, never during the request; once the triggering request has returned, its email is guaranteed to be written even if a process restarts."
1.7 L688 — "Jobs are created in the same transaction…" Proposed: "A successful API response implies that the work it triggers is listed by `GET /__test/jobs` and will be carried out."
1.8 L637 — "…and enqueues jobs" → "…and creates the resulting digest and reminder jobs".
1.9 L746 — "job retry and lease times" → "job retry times, the 60-second recovery of interrupted jobs".
1.10 L771 — "when the endpoint's queue is empty" → "when the endpoint has no earlier delivery still outstanding".
1.11 L256 — "Offsets are therefore not an acceptable cursor implementation." Delete (implementation directive, gives away solution).
1.12 L251 — cursor example decodes to a keyset cursor `{"v":1,"k":[...]}`. Use an opaque-looking value, e.g. `"next_cursor": "c_9QzR2mT7…"`.
1.13 L730 — "State shared with the worker (the clock override) is stored in the database…" → "A clock change made through these endpoints is observed by the API and every running worker before the call returns."
1.14 L740 — "the API process itself does not execute jobs" → "Jobs are carried out only while a worker is running."
1.15 L39, L111 — 64-bit integer ids and `*_minor` amounts as JSON numbers; values above 2^53 lose precision in JavaScript runtimes. Proposed: "Identifiers do not exceed 2^53−1." Serialise `*_minor` as strings, or cap `amount` so every value incl. totals stays ≤ 2^53−1.
1.16 L705 — "Runs pending migrations first." → "Brings the database schema up to date first if needed."
1.17 L709, L689 — SIGTERM/SIGKILL assume POSIX. Add "All commands run on Linux."
1.18 L607 — "the outbox, a durable table in the database" → "the outbox, a durable record kept in the database".

## Category 2: Reads like a test

2.1 L480 — "If several clients claim the same unassigned task at once, exactly one of them succeeds…" → "Claiming is atomic: for a given unassigned task only one claim succeeds and every other claim receives `409 already_assigned`." (see 3.1)
2.2 L256 — "Paging must be stable under concurrent changes…" → "Paging is stable: items created, modified or deleted between page fetches never cause another item to be repeated or skipped."
2.3 L689 — "The worker may be terminated at any moment, including with SIGKILL…" → "Work survives abrupt termination of a worker at any moment: after a restart every job completes without a duplicate email or delivery attempt, and interrupted work resumes within 60 seconds (application clock) of a worker being available."
2.4 L707 — "Run the team's own automated test suite" → "Run the project's automated test suite and exit non-zero on failure." (also category 5)
2.5 L785 — "…covering authorization, pagination, idempotency, concurrency, webhooks, emails, digest timing and soft delete." → "Automated tests for the behaviour in this specification, runnable with `./bin/test`."
2.6 L643 — "If no scheduler run happens at a user's 08:00 (for example because the worker was down)…" → "If the first scheduler run at or after a user's 08:00 happens later that day, the digest is sent at that run; digests for earlier dates are never sent."
2.7 L641 — "…so the corresponding UTC instant shifts when the zone enters or leaves daylight saving time." → "08:00 local time is determined by the zone's rules in force on that date."
2.8 L617 — "…never written again, whatever the circumstances of the job that produces it." → "An email whose dedupe key already exists in the outbox is never written again."
2.9 L772 — "…black-holing connections (accepting TCP, never answering)." → "The targets also apply while a webhook receiver accepts connections but never responds."
2.10 L560 — "A receiver that is slow or unreachable must have no measurable effect on API latency." → "Receiver speed or availability does not affect API response times (see 14.2)."
2.11 L102, L643, L663 — remove bold on **requesting user's**, **current**, **assignee's**.
2.12 L297 — "The two spellings of `é`…" → "Canonically equivalent spellings are therefore the same slug and match the same searches."
2.13 L155 — "the first request that arrives after the revoking request has returned must be rejected." → "Revocation and deactivation take effect as soon as the revoking request returns."
2.14 L599 — "A response that arrives after the attempt's timeout has elapsed is discarded…" → "An attempt without a complete response within the timeout is recorded as `timeout`."
2.15 L775 — heading "14.3 Correctness under concurrency" groups tricky cases. Fold into 3.11 intro: "These invariants hold at all times, under any number of concurrent requests and with up to two workers."
2.16 SMOKE L3 — "passing them means "plausibly working", not "done"." → "These walkthroughs do not replace the specification."
2.17 L572 — signature example is the MD5 of "password" (32 hex); HMAC-SHA256 is 64 hex. Use a neutral 64-hex placeholder.

## Category 3: Internal consistency and verifiability

3.1 L480 vs L476/L624 — claim "sends one task_assigned email" but the claimer is the actor, so rules give zero emails. Drop the clause or state claims send no email.
3.2 L128/L141 vs L370–372 — no activity type for workspace delete/restore or delivery redeliver. Add `workspace.deleted`, `workspace.restored`; redeliver produces no event.
3.3 L374 vs L140/141 — transfer produces two events; unclear if workspace version increments. State: "Transfer increments the workspace version and produces exactly these two events."
3.4 L390 — "The owner's role cannot be changed (403)" vs 409 sole_owner elsewhere; 403 means insufficient role. → "(409 sole_owner)".
3.5 L195 vs L339 — "owns any workspace" vs "owns any non-deleted workspace". Use "owns any workspace, deleted or not" in both.
3.6 L194 vs L482/L137 — removal clears assignee on "every task"; restore handles stale assignee ⇒ contradiction with invariant 2. → "clears assignee_id on every non-deleted task"; restrict invariant 2 to non-deleted tasks.
3.7 L15 — "Deletions are soft" but webhook endpoints are deleted permanently (L530). State the exception.
3.8 L242 vs L282/L278 — 401 before 429 means unauthenticated requests can only get 429 on POST /v1/users; unclear whether 401 counts. → "Requests answered 401 count against the unauthenticated IP bucket; once exhausted such requests receive 429. Only 429 responses are not counted." Adjust precedence.
3.9 L307 — 503 (healthz) missing from 6.3 and body not in error format. Add.
3.10 L737, L744 — test endpoints' 400/409 lack codes → `400 clock_not_overridden`, `409 database_not_empty`.
3.11 L374, L388, L454, L474 — "`422 not_assignable`" shorthand vs "422 with detail code". Add to 6.3: "`422 x` means validation_failed with a detail of code x at the named path."
3.12 L270, L339, L480 — detail objects lack `code` or carry extra keys. Add to 6.2: "A detail always has path and code and may carry additional keys."
3.13 L26/L746 vs L597/L709/L740/L734 — under a frozen application clock, timeouts measured on it never expire. → "Per-operation timeouts and limits (receiver timeout, drain wait, startup/shutdown, reset and seed durations) use real time; every other rule uses the application clock."
3.14 L32/L637 vs L730/L739 — scheduler "part of the worker" yet `/__test/scheduler/tick` served by API runs it synchronously. → "A scheduler evaluation may run in either process; outside test mode one runs every minute, in test mode only on /__test/scheduler/tick."
3.15 L585 vs L102 — webhook task object includes `overdue`, which depends on requester; webhook has none. → "overdue in webhook payloads is computed in the actor's timezone" (or UTC).
3.16 L530 — "pending deliveries move to cancelled before removal" unobservable (404 after). → "its pending deliveries are never attempted."
3.17 L571 vs L581 — attempt-2 timestamp equals occurred_at; second attempt is ≥30 s later. Fix example.
3.18 L766 vs L754 — summary target for "a project with 2,000 tasks" but dataset promises none. Add to 14.1: "including at least one project with 2,000 tasks".
3.19 L470 — "Deleted tasks are never returned; include_deleted=true returns them" self-contradicts; param missing from filter table. → "Without include_deleted=true deleted tasks are not returned." Add to table.
3.20 L248 vs L741/742 — "Every list endpoint accepts limit/cursor" but /__test lists are unpaginated. → "Every list endpoint under /v1 accepts…"
3.21 L254 vs L380 — "id as final tie-breaker" but members ordered by user_id. → "id (for members, user_id)".
3.22 L357 — "409 slug_taken if the slug (given or derived) is in use" yet derived retries with suffix. → "409 slug_taken if a given slug is in use; a derived slug takes the first free numeric suffix."
3.23 L392 vs L180 — "Admins cannot remove admins" vs admin may leave. → "Admins cannot remove other admins (403); any admin may leave."
3.24 L17 vs L715/L784 — singular vs plural engine wording. Settle: "SQLite, PostgreSQL, or both; the README lists those supported."
3.25 L361 — `my_role` in example, not in 3.3 table. Add "(read-only, requester's role)".
3.26 L374 — non-member transfer target gets not_assignable but viewers are valid targets. Use `user_not_found` or new `not_member`.
3.27 SMOKE L49 vs SPEC L532–546 — list item shape for deliveries undefined. State "list items have the same shape as the single-delivery response".
3.28 SMOKE L3 vs SPEC L718 — worker also needs TASKWELL_TEST_MODE=true. → "Start the API and one worker, both with TASKWELL_TEST_MODE=true…"
3.29 SMOKE L57 — frozen clock 2026-06-10 predates users' real created_at. Use 2027-06-10.
3.30 L60 — "Only a hash is stored" not checkable over HTTP; acceptable for a security requirement.

## Category 4: Underspecified for a builder (one-line resolutions)

1. L436–454 POST task with assignee_id sends task_assigned? Yes unless assignee is actor; dedupe key uses task.created event id.
2. L274 empty/no-op PATCH bumps version; event/webhook? Emits *.updated with changes: {} plus delivery.
3. L140 indirect changes bump version? Every change to a versioned object, direct or indirect, adds exactly 1.
4. L128/L502 target.id for member events = user id.
5. L591 member object shape in webhooks = members-list item.
6. L517–520 webhook secret bounds; returned in 201 when supplied? 32–256 printable ASCII; always returned in the 201.
7. L520 loopback/private URLs allowed? Any host accepted; no address filtering in v1 (SMOKE 11 needs this).
8. L548 failure vs error: failure = non-2xx or redirect; error = connection/DNS/TLS failure.
9. L550 "up to six further attempts" ambiguous; numbering/order undefined. Six attempts total (immediate + five on 8.3 schedule), numbering continues, goes to end of endpoint's order.
10. L372 workspace restore: cancelled deliveries stay cancelled; endpoints resume.
11. L262 fingerprint covers body only; same key+body on different endpoint replays wrong response. Include method+path; mismatch → 422 idempotency_key_reused.
12. L260/L686 key older than 24 h but not cleaned up: treated as unused.
13. L260 Idempotency-Key on non-creating POSTs (claim, restore, transfer, redeliver): ignored.
14. L285 non-member's request to workspace-scoped object counts in "Key, general".
15. L153–154 malformed vs unknown key: anything not matching `Bearer twl_[A-Za-z0-9]{40}` is malformed (unauthenticated).
16. L69 slug derivation gaps (empty result, suffix past 50, trailing hyphen, caseless scripts, projects derive?). Fall back to workspace/project; cut base so base+suffix ≤ 50 and re-trim; caseless letters allowed; projects derive the same way.
17. L297 "Unicode case folding": full case folding (CaseFolding.txt C+F), Unicode 15.0 or later.
18. L48 IANA zone: any Zone or Link name in tzdata 2024a or later.
19. L203 Content-Type parameters allowed; 415 only when a body is present.
20. L204 JSON body not an object → 422 invalid_type at path "".
21. Unknown query parameters → 400 invalid_query.
22. L470/L490 include_deleted from non-admin → 403, part of cursor binding.
23. L466 overdue=false: accepted, returns non-overdue tasks (or 400; pick one).
24. L274/L111 partial budget in PATCH: budget always complete {currency, amount}.
25. L741 job type values; retry-awaiting job is pending with attempt_count > 0; sort id desc.
26. L754 seeded webhook endpoints: seed active: false.
27. L612/L621 subjects for member_added, comment_added, task_due free-form; each sink line is the email record JSON.
28. L488/L625 comment_added to non-member assignee/creator: exclude non-members.
29. L689 worker killed mid-HTTP attempt: record as error ("worker terminated"), counts toward six, increments X-Taskwell-Attempt.
30. L17 engines: SQLite or PostgreSQL only.
31. L335/L643 timezone change moving local date: at most one digest per local date per dedupe key; a passed date never becomes eligible.
32. L789 "Questions… asked in writing" names no channel; say "document the assumption in the README".
33. L388/L390 admin adding admin → 403; PATCH role owner → 422 invalid_enum.
34. L737 negative seconds → 422 out_of_range.
35. L206 PATCH/claim/restore responses carry ETag: yes.
36. L364 owner cannot discover deleted workspace ids: include_deleted=true on GET /v1/workspaces for owned workspaces.
37. L617/L743 DELETE /__test/emails also forgets dedupe history? State one (suggest: forgets).
38. L46 "exactly one @" allows "@" or "a@": local and domain parts non-empty.

## Category 5: Name leakage

5.1 L786 — "Postman collection" is a product name → "a machine-readable API description (for example OpenAPI)".
5.2 L48, L113, L316, L323; SMOKE L9, L57 — a regional timezone and two regional currencies in the examples narrow down the organiser's location. Use `Europe/Athens` (also UTC+3 in June, SMOKE 13 arithmetic holds); replace `MDL 2, RON 2` with `SEK 2, PLN 2`.

## Verdict: READY WITH EDITS

Required: 1.1, 1.2, 1.3–1.10, 1.13, 1.11, 1.12, 1.15; 2.1–2.5, 2.17; 3.1, 3.2, 3.4, 3.5, 3.6, 3.7, 3.8, 3.13, 3.14, 3.15, 3.18, 3.28; 4.7, 4.9, 4.11, 4.12, 4.16, 4.17, 4.18, 4.25, 4.26, 4.29; 5.1, 5.2.

| Category | Count |
|---|---|
| 1 Stack neutrality | 18 |
| 2 Reads like a test | 17 |
| 3 Consistency | 30 |
| 4 Underspecified | 38 |
| 5 Name leakage | 2 |
