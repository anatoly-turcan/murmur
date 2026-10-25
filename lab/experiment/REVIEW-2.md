# Taskwell SPEC/SMOKE review — round 2 verification (2026-10-24)

Verdict: READY WITH EDITS. Line numbers = the SPEC.md draft after round 1; the edits were applied before the freeze.

## (a) Partly applied
1. L26 glossary "Application clock" still says every time-dependent rule uses it; L754 contradicts itself. Glossary: "…uses the application clock, except the per-operation timeouts listed at the end of 13.4." L754: start the list with "All other time-dependent behaviour — …".
2. L381/L129 vs L144 ownership transfer: "exactly two events" vs invariant 6 (one event per mutation ⇒ three). Targets unspecified; `ownership.transferred` has target type member so `target_type=workspace` misses it. Proposed: "`ownership.transferred` targets the new owner and `member.role_changed` targets the previous owner; transfer produces exactly these two events and no others." Reword invariant 6: "Every successful mutating request produces the activity events specified for it, and no others."

## (b) Introduced by edits
3. L69 slug derivation lost the 50-char cap when no suffix. "…hyphens trimmed from both ends, cut to 50 chars and re-trimmed; if the result is empty…"
4. L69 letter wording: "lowercase or caseless letters of any script (no uppercase or titlecase letters), digits and hyphens".
5. L525 example secret "optional-32-plus-chars" is 22 chars; rule says 32–256. Use a 32+ value.
6. L245–249 vs L745/L752: `400 clock_not_overridden`, `409 database_not_empty` missing from 6.3 table. Add, marked "(test endpoints)".
7. L7 vs L793: gaps "raised as a question" vs "document assumption in README". L7: "Anything not described here is an implementation choice; document notable ones in the README (section 15)."
8. L558 vs L606/L608 redelivery: "end of endpoint's order" vs "strictly in creation order"; attempt numbering past 6 makes "after the sixth failed attempt" ambiguous. L608: "…in creation order, where a redelivered delivery counts as created at the time of the redeliver request…". L606: "…after the sixth failed attempt of a series…".
9. L15 vs L748: "API requests never wait for it" false for `/__test/jobs/drain`. → "`/v1` requests never wait for it."
10. L285 vs L291 rate-limit table cell: "requests that are not workspace-scoped, and workspace-scoped requests from non-members".
11. L261 cursor rejection clause: "…different filter, sort or `include_deleted` values…".
12. L364: "a derived slug that is taken gets the first free numeric suffix (3.3)."
13. L210 ETag list: add "create (`201`)".
Advisory: 15-digit amounts ⇒ `total_minor` can exceed 64-bit; SQLite SUM errors on overflow. Add to 3.7: "Aggregates are exact regardless of size."

## (c) Still nudging
14. L747 tick response `digests_enqueued`/`reminders_enqueued` → `digests_created`/`reminders_created`.
15. L697 "Jobs are processed at least once" → "A job may be executed more than once; every job's effect is written so that…".

Checked consistent: cross-refs, SMOKE 13 times for 2027-06-10, 64-hex signature, attempt-2 timestamp, SMOKE 4/6/7/11, *_minor strings everywhere, leakage clean.
