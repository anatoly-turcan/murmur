# murmur changes vs Taskwell traps — template (never filled: the experiment stopped at the pilots; see `docs/research/post-mortem.md` §5)

Disclosure required by EXPERIMENT.md D7 / C4 / go/no-go G15. Published with the results.

**Scope.** Every murmur feature, capability, helper, doc page, plugin skill/agent prompt or example change that was added or changed **after SPEC.md v1.0 existed (2026-10-24)**, up to the frozen snapshot. For each one, name every TRAPS.md row it makes easier, or write `none`. When in doubt, list the change: over-disclosure costs nothing.

- Snapshot tag / sha256: `______`
- SPEC.md first version (git): `______`
- murmur range reviewed: `<first commit after SPEC>..<snapshot commit>`; command: `git -C <murmur repo> log --reverse --format='%h %ad %s' --date=short <range>`
- Filled by: `______`, date: `______`

## Changes

| # | murmur commit(s) | Date | Change (feature, capability, doc, prompt, example) | Traps eased (TRAPS ids or `none`) | How it eases them | Would it exist without Taskwell? (yes / no / unsure) |
|---|---|---|---|---|---|---|
| 1 | | | | | | |

## Per-category check

Tick each category after you have checked the snapshot for anything that pre-solves it. Note the change number(s) from the table above, or `none`.

| Category | Examples of what would count | Change #s or `none` | ✓ |
|---|---|---|---|
| A Concurrency | atomic claim helpers, conditional-update or version-check primitives, idempotency-key store | | ☐ |
| B Time | timezone-aware scheduling, "first run at or after local HH:MM", mockable clock shared across processes | | ☐ |
| C Pagination | cursor encoding bound to filters, stable keyset paging helpers | | ☐ |
| D Authorization | role tables, visibility-rule helpers, 404-vs-403 conventions | | ☐ |
| E Soft delete | cascade/restore helpers, deleted-at scoping | | ☐ |
| F Webhook delivery | outbox, per-endpoint ordered delivery, retry schedules, HMAC signing | | ☐ |
| G Exactly-once side effects | `kv.once`-style effect markers, dedupe keys, crash recovery of in-flight jobs | | ☐ |
| H Numbers | decimal/minor-unit money helpers, exact aggregates | | ☐ |
| I Input and validation | error-envelope helpers, Unicode normalisation, contract validation mapped to 422 details | | ☐ |
| J Rate limiting | fixed-window limiter with multiple buckets and RateLimit-* headers | | ☐ |
| K Search | substring search with ranking tiers | | ☐ |
| L Controlled ambiguities | docs or prompts that nudge toward the TRAPS "good resolution" | | ☐ |
| Example app | `examples/*` implementing any of the above | | ☐ |
| Plugin prompts | `piece-writer` / `piece-reviewer` / skills mentioning any of the above | | ☐ |
