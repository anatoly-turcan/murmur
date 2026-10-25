# murmur — design brief

> What murmur is for and the choices that shape it. Authoritative on *why*; `spec.md` is authoritative on *how*,
> `design-v0.3.md` carries the reasoning behind the request pipeline and the durable lane. The framework is frozen
> at 0.3.0.

## Thesis

AI coding agents fail on large context. So: build apps from many small **pieces**, each small enough that one agent
session holds the whole piece (code + tests + context + the contracts it touches) and nothing else. Pieces never
import each other. They talk only through a **bus** using typed **contracts**. A piece does not know whether anyone
produces the messages it handles or consumes the ones it emits. Code is a build artifact; `context.md` + contracts +
tests are the durable source of truth, so a piece can be regenerated from scratch by an agent. Pieces are also the
natural unit of parallel agent work (disjoint files, few merge conflicts; contracts are the only shared surface).

Name: **murmur** (murmuration — thousands of birds moving as one through local signals only).

The experiment is DX for agents and humans: a small assembled context per session, strong enforced boundaries,
regenerable units, observability of the flock. Architecture novelty is small and that is fine.

## Non-goals

Polyglot pieces, a frontend runtime, real sandboxing, event versioning. The design does not block them: core has no
`node:*` imports, the wire envelope is a written spec, contracts export JSON Schema.

## The four lanes (Factorio bus metaphor)

A piece declares what it takes from each lane; the framework resolves them at boot and fails fast.

1. **Messages**: the bus. Dynamic, async. `this.emit`, `this.request`.
2. **Contracts**: typed message classes. Static. Owned by nobody; producer and consumer both import them.
3. **Config**: static values declared with a schema, resolved from env and yaml by the framework, injected. Pieces
   never read `process.env`.
4. **Capabilities**: handles to the outside world (sqlite, kv, fetch, jobs, http, clock, log, ids). Declared in
   `needs`, injected on `this`. Third-party libraries live inside capabilities, not pieces. Grants double as a
   permission model and a catalog ("who touches the database").

## Piece

A folder with one class in `piece.ts`; other files are private to the folder.

```
pieces/todos/
  context.md        for the agent: what, why, lanes, invariants, gotchas
  piece.ts          export class Todos extends Piece({ needs, config, emits }) — ports only
  repository.ts     private helpers (any number of files)
  schema.sql        the tables this piece writes
  piece.test.ts     node:test via testPiece; fixtures double as living examples of payload shapes
  fixtures/
```

```ts
export class Todos extends Piece({ needs: { db: sqlite, jobs }, emits: [TodoCreated] }) {
  private readonly todos = new TodoRepository(this.db);

  @Handle(CreateTodo)
  async create(input: CreateTodo, delivery: Delivery): Promise<Todo> { … }
}
```

- **Class style with standard decorators.** `@Handle(Contract)` and `@Serve(binding)` mark ports; tsc checks the
  parameter and return type against the contract on the decorator line. `this.emit` / `this.request` / `this.log`
  rely on the bus's async context, so no `ctx` threading; per-delivery facts (envelope, attempt, signal) are an
  optional second parameter. Needs are fields (`this.db`), available to field initialisers; no constructor.
- Decorators are not erasable, so the framework provides the transform (a loader hook registered by every CLI
  command that runs app code). Framework packages stay erasable TS with few, well-chosen dependencies.
- **Pieces are modules**: a class plus repository and helpers, tests, fixtures, `context.md`. Pieces may import
  `node:*` and the app's declared dependencies; the one import ban is another piece.
- The handler's return is the reply when the delivery came from a request. A business refusal is a returned
  `reject(…)`; not found is `null`; a throw means the operation did not happen and is retried.
- Handlers are idempotent under redelivery, keyed on the envelope id.

## Contracts

Classes, not tokens. Zod is the schema engine in user land; core reads schemas through Standard Schema and stays
zero-dep. JSON Schema export for free.

```ts
export class Todo extends Model({ id: z.string(), title: z.string(), done: z.boolean() }) {}
export class CreateTodo extends Command({ title: z.string().min(1) }, Todo) {}
export class GetTodo extends Query({ id: z.string() }, Todo.nullable()) {}
export class TodoCreated extends Event({ id: z.string(), title: z.string() }) {}
```

- One class is the value, the input type and the schema owner: no `Input<typeof X>` helpers.
- **Kinds**: `Query` is side-effect free and is deduplicated per trace; `Command` has effects and is never
  deduplicated; `Event` is fire and forget; `Guard` is admission for an ingress route.
- Wire name derived from file and class name (`contracts/todos.ts` → `todos.CreateTodo`), override allowed.
- Public contracts live in `contracts/<domain>.ts`; a group's `contracts.ts` is internal to its subtree (visibility
  is static and lint-enforced; the bus stays flat).
- The catalog is **derived** from code (who emits, requests, handles, serves what), never maintained by hand. Dev
  warnings, not errors: subscribed-never-emitted, emitted-never-subscribed, requested-never-handled.

## Envelope (a written wire spec)

`{ id, name, traceId, causationId?, correlationId?, replyTo?, deadline?, ts, hop, source?, payload }`. `traceId` spans
the causal chain from the first external trigger and is the primary log key; `causationId` gives the tree inside a
trace; `correlationId`/`replyTo`/`deadline` belong to request/reply; `hop` stops runaway cascades; `ts` is a Temporal
instant string; the payload is always JSON. No framework name on the wire: `$` is the reserved prefix (`$sys.*` for
observability, `$reply.<id>` inboxes, `$ingress.<transport>` entry roots, `$dlq.` for transports that need it).

## Transport

At-least-once by design; the memory transport implements it trivially, AMQP (RabbitMQ) proves the interface. The
framework acks on resolve, retries with backoff on throw and dead-letters after N attempts; handlers are idempotent.
`request()` = publish + reply topic + correlation id + timeout. A request answered in the same process takes an
in-process shortcut with the same semantics. Scaling path with the same piece code: one process → named processes
on one database → a broker.

## Ingress belongs to pieces

- Nothing route-like in `murmur.config.ts`. An **edge piece** declares what it serves: `@Serve(web.get('/todos'))` on
  a method, or the class-level shorthand `@Serve(web.get('/todos'), ListTodos)` that forwards to a contract. Each
  ingress capability ships its binding makers and adapter; a new transport needs no core change. Raw escape hatch per
  transport (web `Request`/`Response`, streaming included).
- **Edge vs domain pieces.** The domain piece handles the contract and knows no transport; the edge reads the request
  (`req.read`), calls one contract and answers (`req.reply`). Edges own transport, not every status code: a domain
  handler whose output is `rejectable(M)` returns `reject(404 | 409 | 412, …)` and the edge renders it unchanged.
- **Admission is app-level policy.** `http({ guards: [Authenticate, RateLimit] })` applies to every route; routes
  `skip` or add guards and fill `meta` for the guards' declared shapes. Guards are request contracts answered by
  normal pieces, run in order, one at a time; the first `Rejection` answers; outputs merge onto `req.auth`. Guard
  ordering and meta are checked at boot.
- Client retries of a create are a route option (`idempotent: { scope }`), never app code.
- Conflicts and shadowed routes are the framework's job: boot error naming both pieces, check finding, catalog row.
- Shared conventions (error envelope, input failure map) are token options; shared pure code lives in `lib/`.

## The durable lane is the database

The bus is not durable on the memory transport: events stay in one process. Durable, delayed and periodic work is a
**job** on the app's SQL database: `this.jobs.enqueue(Command, input)` inside the write transaction (the job exists
only if the write commits), `@Handle(C, { every: '1m' })` for schedules, a retry ladder per job command. **One writer
per table**: readers declare the table in `context.md`. Processes are named in `defineApp({ processes })` and booted
with `murmur start <process>`; cross-process work goes through jobs, and static analysis flags requests and events
that would cross processes.

## Platform

- Node 26, native TS type stripping for framework code, no build step. pnpm workspace. typescript 7 (`tsc`), oxlint,
  oxfmt, zod.
- Platform APIs first: `AsyncLocalStorage`, `using`/`await using`, `AbortSignal`, `Temporal`, `node:test`,
  `node:sqlite`, `fetch`, `fs.glob`.
- Default handles always present: `log`, `clock` (Temporal; overridable in test environments), `ids`.
- Config lane: env + optional `murmur.yaml`, validated at boot, `.env` files loaded by `dev`/`start`.

## Observability: the framework eats its own dog food

The runtime publishes internal events on `$sys.*` (piece and capability lifecycle, deliveries, requests, ingress
entries, jobs, log lines). Everything else consumes them:

- **CLI**: `murmur dev`, `start`, `migrate`, `tail`, `trace <id>`, `emit`, `catalog`, `ctx <piece>` (assembles the
  agent brief), `new piece|contract|lib|app`, `check` (boundaries, routes, lint, format), `test`, `doctor`. Agents use
  the CLI through their shell.
- **Web UI** (React + Vite, served by `murmur dev`): sidebar = folder tree; live graph of pieces with groups collapsed
  to one node; events table; trace waterfall built from `causationId`; piece pages with context, contracts, serves,
  deliveries, logs and the ctx brief with its token meter. Failures red. Genuinely good UX.

## Groups, identity, context

- Hierarchy = the folder tree under `pieces/`, any depth. A folder with `piece.ts` is a piece; folders without one are
  groups (`context.md`, internal `contracts.ts`, `scenario.test.ts`). No runtime difference.
- **Piece id = folder path** (`api/rest`); rename the folder = rename the piece. Human metadata in `context.md`
  frontmatter at every level: `title` and a one-line `summary` (catalog rows, parent briefs, UI labels).
- Context inherits downward: an agent on `billing/sim/rates` gets each ancestor `context.md` plus its own.
- The brief is assembled mechanically: the context chain, `context.md`, the folder's file list, owned storage, the
  contracts it touches, routes it serves, one-page capability docs for its `needs`, config keys, catalog rows; code and
  tests on request.

## Piece model vs bus runtime

Two layers in core. The **piece model** (contracts, `Piece`, decorators, bindings, admission, names, observability
schema) never imports the **bus runtime** (transport, delivery, retry, request/reply). Tooling (CLI, UI, plugin)
depends on the model only. The core asset is the model plus the tooling, not the bus.

## Sizing

- The unit is one responsibility, one owner of state, a handful of handlers — not one function. A store piece with
  get/create/update/delete/list is one piece; a saga with five handlers is one piece.
- Heuristics in order: (1) describable in one sentence without "and"; (2) one writer of each table; readers declare
  the table in context.md; (3) things that change together live together; (4) handlers sharing no state or helpers
  are a split smell; (5) start coarse, split on pain, never speculatively.
- Caps are warnings tuned by data: brief large 25k / warn 40k / fail 80k tokens, ~1,500 source lines, ~20 handlers
  (plus routes), `context.md` ~120 lines. No lower bound: one tiny stateless handler is allowed, flagged by review
  only. Cohesion (one concept, one owner of its storage) is the real rule.

## Code style (debuggability first)

Every `if`/`for`/`while` body is a block; every statement ends with `;`. Blank lines group code into paragraphs: a run
of declarations is one group, a multi-line `await` statement is its own group, a run of one-line awaits is one group,
a single one-line declaration stays attached to the block that reads it, and there is a blank line around every
block and before `return` unless it is the only statement. No statement ternaries, no `cond && doIt()`, no nested
ternaries, no comments in function bodies. Strict TypeScript (`exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, …), no `any`, no `!`, explicit return types on
exported functions and class methods, exhaustive `switch` over unions. Enforced by lint and oxfmt; scaffolds, docs
and plugin texts follow it.

## Agent-first extras

- Claude Code plugin in the repo (`plugins/murmur`): agents `piece-writer`, `piece-reviewer`; skills `murmur-piece`
  (write or regenerate from contracts + context + tests), `murmur-contract`, `murmur-review`; hooks that run
  `murmur check` after edits.
- Knowledge: `context.md` is piece-local; app-wide durable knowledge uses the `.agents/` convention. No duplication.

## Layout

```
packages/core              contracts, Piece, decorators, envelope, bus, run context, Transport interface; zero deps, no node:*
packages/node              defineApp, runtime, loader, config lane, capabilities, test helpers, lib helpers
packages/transport-memory
packages/transport-amqp
packages/cli               bin murmur
packages/dev-protocol      types shared by the dev server, CLI and UI
packages/ui
packages/lint              oxlint preset + rules, oxfmt config
plugins/murmur             Claude Code plugin
examples/todo-api          REST + SQLite + SSE app proving the whole thing
docs/                      seven user pages, shipped inside @murmur/cli
```

## Known risks

Framework-becomes-the-project (timebox); event-first makes CRUD harder (the request sugar, shorthands and rejectable
outputs exist to keep it cheap); boundary erosion without lint; contract evolution and versioning (parked); cascade
depth and hot paths (the trace waterfall and the hop counter make them visible); per-request database writes in
shared primitives (a `kv.incr` rate limiter writes on every request).
