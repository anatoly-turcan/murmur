# SPEC review checklist (sealed during the experiment)

Use before releasing SPEC.md or SMOKE.md to teams. Each item is a yes/no check.

## Stack neutrality

- [ ] No programming language, framework, ORM, web server, queue, cache or library is named anywhere in SPEC.md or SMOKE.md (grep for: node, python, go, rust, java, ruby, php, express, fastapi, django, rails, spring, laravel, gin, axum, prisma, sqlalchemy, redis, kafka, rabbit, celery, sidekiq, bull, cron, docker, kubernetes, npm, pip, cargo, maven).
- [ ] The only storage names used are "SQLite" and "PostgreSQL", presented as acceptable choices, not as a requirement for a specific one.
- [ ] Operational commands are generic executables (`./bin/*`), with "shell scripts are fine", and no package-manager invocations.
- [ ] Nothing in the spec presupposes a particular process model (threads vs. event loop), a particular job-queue product, or a specific HTTP router convention.
- [ ] Test endpoints are expressed as HTTP behaviour only, never as "call function X" or "set flag in config file Y".

## Does not read like a test plan

- [ ] No section is titled or framed as "edge cases", "pitfalls", "gotchas", "common mistakes" or similar.
- [ ] Difficult requirements appear as ordinary sentences inside the feature they belong to, not grouped into lists of traps.
- [ ] The words "benchmark", "test teams", "trap", "hidden suite", "scored", "graded" and "evaluation" do not appear in public files (grep them).
- [ ] SMOKE.md contains only happy paths; no scenario depends on a race, a DST transition, a crash or a conflicting write.
- [ ] Example values look like product data (`acme-ops`, `Fix login redirect`), not like test fixtures (`test1`, `foo`, `trap-case`).
- [ ] Where the spec is intentionally silent (the three controlled ambiguities in TRAPS.md), the surrounding text does not draw attention to the gap.

## Completeness and verifiability

- [ ] Every endpoint in section 7 states method, path, required role, request fields, success status and body, and the error statuses specific to it.
- [ ] Every status code used anywhere is listed in 6.3 with a `code` value.
- [ ] Every time-dependent rule (overdue, digest, reminders, retries, leases, rate-limit windows, idempotency expiry) explicitly references the application clock, so the test clock controls it.
- [ ] Every asynchronous effect is observable over HTTP: outbox via `/__test/emails`, deliveries via `/v1/webhooks/{id}/deliveries`, jobs via `/__test/jobs`.
- [ ] Each non-functional target names a dataset, a concurrency level and a percentile.
- [ ] Cross-references (section numbers) resolve to the right sections after any edit.

## Consistency

- [ ] Field names and enum values are spelled identically in the domain model, endpoint examples, webhook payloads and email records.
- [ ] The permission table and the per-endpoint "Admin+/Member+" annotations agree.
- [ ] Ordering rules for each list end with `id` as tie-breaker and match the cursor-binding rule in 6.4.
- [ ] Dedupe-key formats in 9.2 match the exactly-once wording in 9.1 and 12.
