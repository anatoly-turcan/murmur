---
name: murmur-review
description: Review changed murmur pieces (boundaries, idempotency, reply shapes, tests, context.md, sizing) and give a mergeable / needs-changes verdict. Use after writing pieces or before merging.
argument-hint: '[piece path | --changed]'
---

# /murmur-review [path | --changed]

Repo facts come from the murmur CLI, run with Bash from the app root (`pnpm exec murmur …`); never grep the repo.

1. `pnpm exec murmur check --changed --types --json` (changed includes untracked files), or
   `pnpm exec murmur check <path> --types --json` when a path is given. Group findings by piece folder.
2. Spawn one `piece-reviewer` agent per changed piece, **in parallel** (one message, several Agent calls), each with
   the piece id and that piece's findings. Each reviewer runs `pnpm exec murmur ctx pieces/<id> --with code,tests
   --format md` first, then Reads only the other folder files the review touches.
3. Aggregate: overall verdict is `mergeable` only when every reviewer says `mergeable` and the check JSON has
   `ok: true`. Merge the `file:line — issue — fix` lists, errors first.
4. When `murmur dev` runs and a recent trace exists for a reviewed piece (`pnpm exec murmur tail --piece <id>
   --no-follow --json`, then `pnpm exec murmur trace <traceId>`), attach its waterfall text.

Output: verdict line, then findings per piece, then the trace waterfall if any.
