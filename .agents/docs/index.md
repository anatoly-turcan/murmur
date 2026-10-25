# Docs index

> Memory router. Read only the relevant doc(s); never load all. Canonical code in `packages/*` wins over memory.
> Choices and rationale: `.agents/decisions.md`. murmur is frozen at 0.3.0; the research verdict and the benchmark
> lab live in `docs/research/`.

## Navigation

- [brief.md](brief.md) — what murmur is and why: thesis, lanes, pieces as classes, contract kinds, edge vs domain
  pieces, admission, the durable lane, observability, groups and identity, sizing, code style, risks. Read first.
- [spec.md](spec.md) — the technical spec of 0.3.0: contracts and wire names, `Piece` and decorators, bus dispatch,
  request/reply, dedupe and shutdown, envelope, transports, node runtime and boot, config lane, processes, loader,
  capabilities (sqlite, kv, fetch, clock, jobs), HTTP ingress and admission, the lib lane, testing, CLI (ctx rules,
  check findings), dev protocol and UI, lint and style, sizing, plugin, the reference app. Read before changing any
  package.
- [design-v0.3.md](design-v0.3.md) — why the request pipeline and the durable lane look the way they do: the pilot
  evidence of what teams rebuilt by hand, principles, the ten mechanisms with writer-facing TypeScript, expected
  reduction, milestones with proofs, open decisions, what stays app-side, where the implementation departs. Read
  when a task hinges on why admission, `req.read`/`req.reply`, `rejectable`, idempotent routes, jobs or processes
  work as they do.
- [../../docs/api-preview.md](../../docs/api-preview.md) — `examples/todo-api` in full (every file block equals the
  app file, test-enforced): contracts, `capabilities/web`, `processes`, domain, job, guard and edge pieces, tests,
  failure shapes, style rules. Read to see the app surface.
- [../../docs/piece-authoring.md](../../docs/piece-authoring.md) — writing a piece: the class, `@Handle`, contracts,
  errors, idempotency, lost context, config and storage, `context.md` and lane lines, sizing, `testPiece`.
- [../../docs/ingress.md](../../docs/ingress.md) — edge pieces: the web token, bindings, `HttpRequest`, errors,
  guards, idempotent routes, conflicts, SSE, testing an edge, the trace.
- [../../docs/capability-authoring.md](../../docs/capability-authoring.md) — `defineCapability`, ALS-aware handles,
  handle docs, lifecycle, the ingress port, built-ins and their return values, fakes.
- [../../docs/cli.md](../../docs/cli.md) — every `murmur` command, flags and exit codes, the loader.
- [../../docs/dev-protocol.md](../../docs/dev-protocol.md) — HTTP + SSE API of `murmur dev` and its shapes.
- [../../docs/envelope.md](../../docs/envelope.md) — the wire record, names, request/reply, `$sys.*`, retries.
