# Disputes: hidden suite vs SPEC.md

One entry per disputed test. The implementation follows SPEC.md; the test is left failing. None was ever
adjudicated: the experiment closed before phase 2.

Entry format:

```
## <test file> — <test name>

- Assertion: <exact assertion text or expected-vs-actual>
- SPEC: §<section> — "<quote>"
- Reading: <why the test and SPEC disagree, or why SPEC is ambiguous>
- Implemented: <what the reference does>
```

## tests/errors-http.test.ts — [ERR] POST /v1/workspaces → 201 with application/json; charset=utf-8 (SUITE_CR=CR-1 and later)

- Assertion: `expectStatus(res, 201)`; actual `422 validation_failed` with
  `details: [{path: "organization_id", code: "required"}]`.
- SPEC: PHASE2.md CR-1 Endpoints — "`POST /v1/workspaces` now requires `organization_id` in the body"; acceptance
  criterion 8 — "All v1 hidden tests still pass, with `organization_id` added to workspace creation calls."
- Reading: the test sends its body as `rawBody: JSON.stringify({ name })`. The CR-1 call adaptation
  (`lib/cr-adapter.ts` `injectOrganization`) only rewrites a plain-object `body`, so this workspace creation call
  reaches the candidate without `organization_id`, which criterion 8 says the v1 calls get. The 422 is the
  behaviour CR-1 requires. Adapting the raw body as well (parse, add `organization_id`, re-serialize, keep the
  content type) would restore the test's intent, which is the charset parameter on the media type.
- Implemented: `organization_id` is required on `POST /v1/workspaces`; a body without it is
  `422 validation_failed` (`organization_id`, `required`), as asserted by `[CR1-H] POST /v1/workspaces requires
  organization_id`.

## tests/smoke.test.ts — [SMOKE-3] welcome email (SUITE_CR=CR-2 and later)

- Assertion: `assert.match(e.dedupe_key, /^member_added:<ws.id>:<user.id>:\d+$/)`; actual
  `member_added:<ws uuid>:<user uuid>:<activity event uuid>`, e.g.
  `member_added:01a16dc5-0582-77e4-8f89-36f01dccedfd:01a16dc5-0577-709a-8f61-3f316869e255:01a16dc5-0584-7760-ba8e-e1f8bb73a081`.
- SPEC: §9.2 — "`member_added:<workspace_id>:<user_id>:<activity_event_id>`"; PHASE2.md CR-2 Request — "Replace all public
  integer identifiers (users, API keys, workspaces, projects, tasks, comments, activity events, …) with UUIDv7 strings",
  and Specification — "Every `id` and every `*_id` field … becomes a lowercase RFC 9562 UUIDv7 string".
- Reading: under CR-2 the activity event id is a UUIDv7, so the last segment of the dedupe key is one too. The smoke
  walkthrough keeps the v1 `\d+` pattern for that segment; the CR-2 call adaptation (`lib/ids.ts`) covers the workspace
  and user ids interpolated into the pattern but not the literal `\d+`. `[CR2-U] email dedupe keys embed the UUIDs of the
  objects they name` asserts the same key with `[0-9a-f-]{36}` as the last segment, so no build can pass both under
  CR-2. Accepting `idPattern()` for the last segment (as `lib/ids.ts` offers) would restore the walkthrough.
- Implemented: dedupe keys embed the UUIDs of the objects they name, including the activity event, as `[CR2-U]` asserts.

## tests/cr3-audit.test.ts — [CR3-2] an idempotent replay and rejected requests add no entries (SUITE_CR=CR-3)

- Assertion: `assert.equal(await count(), baseline, 'no 4xx writes an entry')`; actual `9 !== 6`. It failed in 4 of 4
  runs of `cr3-audit.test.ts` on its own and passed in the full `SUITE_CR=CR-3` run. The three extra entries are the
  `system` `send` entries of the three `member_added` welcome emails that `auditTeam()` triggers by adding the admin,
  member and viewer. The worker writes them asynchronously, and here it wrote them after `baseline` was taken. Run
  alone with `--test-name-pattern`, the same test leaves the workspace's entries in this order: workspace, three
  members, then `send`, project, `send`, `send`, task. No replayed or rejected request is among them.
- SPEC: PHASE2.md CR-3 Request — "Record an immutable audit entry for every mutation in the system, including
  mutations performed by the worker"; Specification — "Worker-originated mutations (… webhook delivery state
  changes and email sends are worker-originated) use `actor.type: "system"` with `action` `deliver` or `send`, and
  `after` containing the delivery or email record."
- Reading: a welcome email is sent for a membership of the workspace, so its `send` entry belongs to that workspace's
  audit. `[CR3-5] emails sent by the worker are audited as system send entries holding the email record` reads `send`
  entries from the same workspace audit. `count()` counts every entry in the workspace audit without draining the job
  queue first, so the result depends on whether the worker sends the three emails before `baseline` or between
  `baseline` and the final count. Calling `drainAll()` before taking `baseline`, or counting `userOriginated(...)`
  entries as `[CR3-1]` does, would make the test deterministic and still prove that replays and 4xx responses write
  nothing.
- Implemented: the worker audits every email it writes to the outbox as a `send` entry, scoped to the email's
  workspace. Idempotent replays and 4xx responses write no entry.
