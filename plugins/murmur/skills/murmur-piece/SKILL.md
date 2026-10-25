---
name: murmur-piece
description: Write or regenerate one murmur piece from its contracts, context.md and tests. Use when asked to create, rewrite, regenerate or fix a piece under pieces/ (e.g. "/murmur-piece todos/create from scratch").
argument-hint: <piece id> [from scratch]
---

# /murmur-piece `<id>` [from scratch]

`<id>` is the piece id (`todos/create`); every command below takes it as `pieces/<id>`.

Orchestrates one piece end to end. Repo knowledge comes only from the murmur CLI, run with Bash from the app root
(`pnpm exec murmur …`); never grep or browse the repo.

## Steps

1. **One responsibility.** Describe the request in one sentence. If it needs "and", it is two pieces: stop, name both,
   and run `/murmur-piece` once per piece.
2. **Dev server.** `pnpm exec murmur doctor --json`: `lock` is `live` while `murmur dev` runs. Otherwise start
   `pnpm exec murmur dev` in a background shell (Bash, `run_in_background`) and re-run doctor until `lock` is `live`.
3. **Scaffold.** `pnpm exec murmur ctx pieces/<id> --format md`; when the piece is missing (exit 2, unknown id),
   scaffold it first: `pnpm exec murmur new piece pieces/<id> --summary "…" --handles C1,C2 --emits E --needs db=sqlite
   --config key:type --idempotent` for a domain piece, `--edge --serve 'get /todos/:id'` for an edge
   (`'post /x=CreateX'` for a shorthand; the `routes` array of `pnpm exec murmur catalog --json` shows which edge
   already owns a path family). A contract that does not exist yet → stop and suggest `/murmur-contract`.
4. **Write.** Spawn the `piece-writer` agent with the ctx markdown as its only repo context, plus the user's request
   and "from scratch" when given. The brief carries no code: its `## Files` section lists the folder and the writer
   Reads only the files the task touches (add `--with tests` or `--with code` when they should be inline). From
   scratch, take the brief with `pnpm exec murmur ctx pieces/<id> --withhold-code --format md` so the old
   `piece.ts` and private files are not listed; they are rewritten, `context.md`, contracts and tests are kept as the
   spec.
5. **Prove.** `pnpm exec murmur test pieces/<id>` must be green. Then `pnpm exec murmur emit <wire name> --fixture
   pieces/<id>/fixtures/<file>.json` (add `--request` for a query or command) and `pnpm exec murmur trace
   <traceId>` to confirm the delivery was acked (and replied). For an edge, call one of its routes over HTTP and
   trace it: the ingress root, the guards, the domain request.
6. **Review.** Hand off to `/murmur-review pieces/<id>`.

Report: files touched, test counts, trace id, open doubts from the writer's summary.

## Sizing

<!-- sizing:start -->

The unit is one responsibility, one owner of state, a handful of handlers — not one function: a store piece with
get/create/update/delete/list is one piece; a saga with five handlers is one piece. In order:

1. describable in one sentence without "and";
2. one writer of each table; readers declare the table in context.md;
3. things that change together live together;
4. handlers sharing no state or helpers are a split smell;
5. start coarse, split on pain, never speculatively.

Caps (`limits` in `murmur.config.ts`): assembled ctx large 25k / warn 40k / fail 80k tokens, ~1,500 source lines
(excluding tests, fixtures and nested pieces), ~20 handlers, `context.md` ~120 lines. There is no lower bound in any tool: one tiny
stateless handler is legal and only ever gets a _merge candidate_ note from `piece-reviewer`.
<!-- sizing:end -->
