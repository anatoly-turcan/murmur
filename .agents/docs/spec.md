# murmur — technical spec (0.3.0)

> Authoritative on *how*; `brief.md` is authoritative on *why*, `design-v0.3.md` on the reasoning behind the request
> pipeline and the durable lane. Code in `packages/*` wins over this file; `docs/*.md` are the user-facing pages and
> `docs/api-preview.md` is the reference app surface (its file blocks are `examples/todo-api`, byte for byte). Every
> package is at 0.3.0 and frozen.

## 1. Overview & vocabulary

### 1.1 What it is

An app is a flock of small **pieces** that never import each other and talk only through a **bus** using typed
**contracts**. Each piece is a folder: one class in `piece.ts`, a `context.md`, tests, private files. The framework
resolves four **lanes** per piece at boot and fails fast: messages (bus), contracts (static types), config
(schema-validated values) and capabilities (handles to the outside world). `context.md` + contracts + tests are the
regenerable source of truth; code is disposable. Ingress belongs to pieces: an **edge piece** serves routes with
`@Serve`, a **domain piece** knows no transport. Observability is the runtime publishing `$sys.*` events; the CLI and
the web UI consume only those.

### 1.2 Vocabulary (use these words, no synonyms)

| Term | Meaning |
| --- | --- |
| **piece** | a folder under `pieces/` (any depth) whose `piece.ts` exports one class `extends Piece({…})`; the unit of agent work |
| **piece id** | the folder path relative to `pieces/` with `/` (`api/rest`); never written in code; renaming the folder renames the piece |
| **group** | a folder under `pieces/` that holds pieces; may carry `context.md`, an internal `contracts.ts`, a `scenario.test.ts`; no runtime meaning |
| **edge piece** | a piece with `@Serve` ports (HTTP or another ingress); **domain piece**: only `@Handle` ports; **mixed**: both |
| **contract** | a class made by `Query`, `Command`, `Event` or `Guard`; value, input type and schema owner in one |
| **model** | a class made by `Model(shape)`: a named shape, never a message |
| **request** | a query, command or guard: one handler, one reply; **event**: any number of handlers, no reply |
| **wire name** | the contract's name on the bus, `<file domain>.<ClassName>` (`todos.CreateTodo`) |
| **public contract** | exported from `contracts/<domain>.ts`, imported as `#contracts/<domain>` |
| **internal contract** | exported from `pieces/<group>/contracts.ts`, importable only inside that subtree |
| **handler** | a method decorated `@Handle(C)`; a *responder* for requests, a *listener* for events |
| **serve method** | a method decorated `@Serve(binding)`; a **shorthand** is a class decorator `@Serve(binding, C)` forwarding to a contract |
| **binding** | `{ transport, key, capability, guards? }` made by a token's binding maker (`web.get('/todos')`) |
| **guard** | a request contract an ingress runs before a route; answers its model or a `Rejection` |
| **admission** | the guards and route `meta` that decide whether a route runs |
| **rejection** | a returned `reject(status, message, …)`: a business refusal, a successful delivery |
| **envelope** | the wire record (§6) |
| **delivery** | one attempt to run one handler for one envelope; `{ envelope, attempt, signal, piece }` |
| **ingress entry** | one outside event (an HTTP request, a job run) run as a local job of a piece |
| **observer** | `bus.observe(pattern, name, fn)`: auto-ack, never replies, never retries |
| **subscription group** | transport consumer group, one per piece id; the bus selects the handler by envelope name |
| **capability** | a named handle defined with `defineCapability`, declared by a piece in `needs` as a **token** |
| **default handles** | `log`, `clock`, `ids`: always on `this`, never declared |
| **ingress capability** | a capability that brings work in (`http`, `jobs`); stopped first |
| **job** | a durable command row on the app database, claimed and run by the `jobs` capability |
| **process** | a named subset of pieces in `defineApp({ processes })`, booted by `murmur start <name>` |
| **run context** | the `RunContext` in `AsyncLocalStorage` for one delivery, entry or lifecycle hook |
| **background run** | a run opened for an emit or request made outside any run (fresh trace) |
| **trace** | all envelopes sharing a `traceId`; a tree via `causationId`; depth via `hop` |
| **internal event** | `$sys.*`, published by the runtime about itself; `$` is reserved (`$sys`, `$reply`, `$ingress`, `$dlq`) |
| **catalog** | derived table contract → emitters, requesters, handlers, routes; never hand-maintained |
| **brief** | the output of `murmur ctx <id>`: everything one agent needs to work on one piece |
| **lib module** | `lib/<module>.ts`: shared pure code, imported as `#lib/<module>` |

### 1.3 Platform facts the design rests on

- Node 26 runs `.ts` by type stripping; strip-only mode rejects `enum`, `namespace`, decorators and parameter
  properties. Framework source is erasable TS; app code that needs decorators goes through the app loader (§8.6).
- Globals used: `Temporal`, `AsyncDisposableStack`, `AbortSignal.any/timeout`, `crypto.randomUUID`,
  `Promise.withResolvers`, iterator helpers. `AsyncLocalStorage` is imported from `node:async_hooks`.
- `AsyncLocalStorage` follows `await`, timers, microtasks and streams; it does not follow EventEmitter listeners
  (the emit site's store wins), abort listeners or closures drained elsewhere. The bus therefore runs every dispatch
  inside its own `context.run`, built from the envelope.
- `AbortSignal.any([short, longLived])` retains the composite for the life of `longLived`; the hot path uses a plain
  `AbortController` per delivery with a timer cleared in `finally`.
- `node:sqlite` `DatabaseSync` cannot nest `BEGIN` on one connection: the sqlite handle serialises statements and
  transactions behind one async mutex per process.
- `typescript@7.0.2` (bin `tsc`, the native compiler) has no JS API; static analysis parses with `oxc-parser`.
- `yaml` core schema retypes scalars (`01234` → 1234); `murmur.yaml` is parsed with the failsafe schema after
  interpolation, so every scalar is a string until the config coercion types it.
- A broker round-robins one queue's messages across its consumers regardless of binding key: one subscription per
  piece, demultiplexed by name.
- ESM caches modules per URL for the process lifetime: static analysis imports app code only in a short-lived worker.

## 2. Repository layout

### 2.1 Packages

```
packages/
  core/              murmur              contracts, Piece, decorators, bus, envelope, transport interface (zero deps)
  node/              @murmur/node        defineApp, runtime, loader, config lane, capabilities, testing, lib, register
  transport-memory/  @murmur/transport-memory   in-process transport (dev, tests, single process)
  transport-amqp/    @murmur/transport-amqp     RabbitMQ transport (amqplib)
  cli/               @murmur/cli         bin `murmur`: dev, start, migrate, check, ctx, catalog, new, test, …
  dev-protocol/      @murmur/dev-protocol   types shared by the dev server, CLI and UI
  ui/                @murmur/ui          web UI served by `murmur dev` (React, built to dist/)
  lint/              @murmur/lint        oxlint preset + JS-plugin rules, type-aware config, oxfmt config
plugins/murmur/      Claude Code plugin: agents, skills, hooks
examples/todo-api/   the reference app (docs/api-preview.md shows it)
docs/                the seven user pages, shipped inside @murmur/cli
scripts/release/     snapshot, publish, verify for a local registry
```

| Package | Exports | Runtime deps |
| --- | --- | --- |
| `murmur` | `.`, `./testing` | none |
| `@murmur/node` | `.`, `./testing`, `./capabilities`, `./lib`, `./register`, `./register/transform`, `./tsconfig.app.json` | `murmur`, `@murmur/transport-memory`, `zod`, `yaml`, `@swc/core`, `@swc/helpers` |
| `@murmur/transport-memory` | `.` | `murmur` |
| `@murmur/transport-amqp` | `.` | `murmur`, `amqplib` |
| `@murmur/cli` | `.`, `./analysis`, `./render`, `./trace`; bin `murmur` | the above, `@murmur/dev-protocol`, `@murmur/lint`, `@murmur/ui`, `oxc-parser`, `oxlint`, `oxlint-tsgolint`, `oxfmt`, `yaml` |
| `@murmur/dev-protocol` | `.` | `murmur` |
| `@murmur/lint` | `.`, `./preset`, `./type-aware`, `./oxfmt` | none |
| `@murmur/ui` | `.`, `./dist/*` | react, react-dom, d3-force/selection/zoom, markdown-it |

- Workspace: pnpm 12, Node ≥ 26 (`engines`, `.nvmrc`), `"type": "module"`, explicit `.ts` extensions, no build step
  for TS packages (exports point at `.ts`); published packages carry `.ts` sources and run under type stripping.
- Root scripts: `test` (`pnpm -r test`, `node --test`), `lint` (`oxlint && oxlint --type-aware -c
  oxlint.type-aware.json && oxfmt --check`), `lint:fix`, `typecheck` (per package `tsc -p`, `noEmit`, no project
  references), `check` = lint + typecheck + test, `build:ui`, `release:snapshot|publish|verify`.
- CI (`.github/workflows/ci.yml`): Node version assert, `pnpm install --frozen-lockfile`, lint, typecheck, test,
  `build:ui`, the example's `check` and `murmur catalog --strict`; a second job runs the AMQP tests against
  `rabbitmq:4-management`.

### 2.2 Core layout: two halves, one entry

`packages/core/src/model/` is what a piece *is*: contract and model classes, `Piece`, `Handle`, `Serve`, bindings,
`Rejection`, `Paging`/`Page`, `IfMatch`/`etag`, admission problems, job options, names, policy, capability
definition, errors, the `$sys` schema. It never imports the runtime (lint `model-no-runtime`), and it is the only half
tooling imports (`tooling-no-runtime`). `packages/core/src/runtime/` is how messages move: bus (register, dispatch,
request, reply, dedupe, local shortcut, invoke, observe, shutdown), envelope functions, run context, transport
interface. Core imports no `node:*` (`core-no-node`) and has no dependencies; zod arrives through the app (contracts
hold zod schemas; core reads them through Standard Schema).

### 2.3 App conventions (what every tool assumes)

```
murmur.config.ts          default export defineApp({ … })
murmur.yaml               optional values (config lane, capability config)
package.json              "imports": { "#contracts/*": "./contracts/*.ts",
                                       "#capabilities/*": "./capabilities/*/capability.ts", "#lib/*": "./lib/*.ts" }
tsconfig.json             extends "@murmur/node/tsconfig.app.json"
.oxlintrc.json            extends ["./node_modules/@murmur/lint/preset.json"]
contracts/<domain>.ts     public contracts and models
capabilities/<name>/capability.ts   app-local capability tokens (default export); capability.md beside = its docs
lib/<module>.ts           pure shared code + lib/<module>.test.ts
migrations/*.sql          app-wide DDL (optional)
pieces/<id>/piece.ts      one class; context.md; piece.test.ts; schema.sql; fixtures/*.json; private files
pieces/<group>/context.md, contracts.ts, scenario.test.ts
.murmur/                  dev lock, traces, catalog snapshot, caches (git-ignored)
```

The app root is the nearest ancestor holding `murmur.config.ts`. Pieces import only the framework, `node:*`,
`#contracts/*`, `#capabilities/*`, `#lib/*`, ancestor `contracts.ts` files, files in their own folder and the app's
`package.json` dependencies.

## 3. Contracts (`murmur`, model half)

### 3.1 Classes

```ts
export class Todo extends Model({ id: z.string(), title: z.string(), done: z.boolean() }) {}
export class CreateTodo extends Command({ title: z.string().min(1).max(200) }, Todo) {}
export class GetTodo extends Query({ id: z.string() }, Todo.nullable()) {}
export class RenameTodo extends Command({ id: z.string(), title: z.string(), ifMatch: IfMatch }, rejectable(Todo)) {}
export class ListTodos extends Query({ done: z.boolean().optional(), ...Paging() }, rejectable(Page(Todo))) {}
export class TodoCreated extends Event({ id: z.string(), title: z.string() }) {}
export class Authenticate extends Guard(Principal) {}
export class RateLimit extends Guard(Quota, { optional: [Authenticate] }) {}
```

- `Model(spec)`: `spec` is a zod object or a shape of zod schemas. Statics `kind: 'model'`, `schema`, `nullable()`,
  `array()`. A model is never sent on its own; it names an output or a nested shape.
- `Query(input, output, options?)`, `Command(input, output, options?)`: `input` a zod object or shape; `output` a
  `Model` class, a zod schema or a shape. `Event(payload, options?)`: no output. `Guard(OutputModel, { after?,
  optional?, meta?, name?, description? })`: the input is fixed (§10.5), the output is the model or a `Rejection`.
  `options = { name?, description? }`.
- Statics on every contract class: `kind` (`'query' | 'command' | 'event' | 'guard'`), `input` (the zod object),
  `output` (`undefined` for events), `file` (the defining file, captured from the call site), `wireName`,
  `description`, `jsonSchema()` → `{ name, input, output? }` (JSON Schema via `z.toJSONSchema`). Guards add `model`,
  `after`, `optional`, `meta`.
- Types: `InputOf<C>` (what a caller passes, defaults optional), the class instance type (what a handler receives,
  defaults applied), `OutputOf<C>` (`void` for events). Predicates `isContract`, `contractKind`, `isRequestClass`,
  `isModel`.
- The class is the value passed everywhere (`@Handle(C)`, `this.request(C, …)`, `this.emit(C, …)`, `@Serve(b, C)`,
  `t.deliver(C, …)`). Handlers receive validated plain data typed as the class; nobody writes `new C(…)` and outputs
  are plain objects, never `new Model(…)`.
- Semantics by kind: **Query** has no side effects and may be answered once per trace (dedupe, §5.5); **Command** has
  effects and is never deduplicated; **Event** is fire and forget with any number of listeners; **Guard** is a request
  run by an ingress before a route. `this.request` takes a query, command or guard; `this.emit` only an event.

### 3.2 Wire names

- Derived: `<domain>.<ClassName>`. The domain of `contracts/todos.ts` is `todos`, of `contracts/billing/invoices.ts`
  `billing.invoices`, of `pieces/todos/contracts.ts` `todos` (the group path joined with `.`). A contract defined
  elsewhere throws `invalid-name` "cannot derive a wire name for X from <file>: define it in contracts/ or
  pieces/<group>/contracts.ts, or pass { name }".
- `{ name: 'todos.removed' }` overrides. Grammar (`validateName`):

```
segment   := [a-z][a-z0-9-]*
class     := [A-Z][A-Za-z0-9]*
name      := segment ("." segment)* "." (segment | class)     ; ≥ 2 parts, max 255 bytes UTF-8
internal  := "$sys" ("." segment)+
reply     := "$reply." [a-z0-9]{8}
pieceId   := segment ("/" segment)*
pattern   := AMQP topic: "*" = one segment, "#" = zero or more (observers only)
```

- A bad override throws "invalid contract name "X": use lowercase dot-separated segments, optionally ending in a
  ClassName (todos.removed, todos.CreateTodo)". User names never start with `$`. Ingress entry envelopes are named
  `$ingress.<transport>` (`$ingress.http`, `$ingress.job`).
- Identity: one class object per wire name per runtime. Two classes claiming one name (a duplicate or a module loaded
  twice) is boot error `contract-identity`; an internal contract used outside its subtree is `internal-contract-scope`.

### 3.3 Validation and JSON faithfulness

- The publisher validates input (schema output goes on the wire, defaults materialised); the consumer re-validates
  before the handler (invalid → dead-letter at once, `phase: 'validate'`); the responder validates its output
  (`ContractViolationError`, side `reply`, non-retryable). The requester parses the reply against the output schema.
- Schemas must survive a JSON round trip: no `z.coerce.*`, `z.date()`, transforms, `bigint`, functions, maps or sets
  in contracts (lint `contracts-json-faithful`; `murmur check` `contract-json-schema` when `jsonSchema()` throws).
  `IfMatch` is the one sanctioned preprocess (string in, string out).
- Contract factories are called directly in a `class … extends` clause (`contract-factory-wrapped`).

### 3.4 Rejections

```ts
class Rejection extends Model({
  status: z.number().int().min(400).max(599),
  code: z.string(),
  message: z.string(),
  details: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
}) {}
reject(status, message, { code?, details?, headers? }): Rejection
rejectable(Model | schema)  // z.union([strict Rejection, schema]), titled `rejectable(<label>)`
isRejection(value)          // strict shape check
isRejectable(schema)
codeForStatus(status)       // 400 invalid_input, 401 unauthorized, 403 forbidden, 404 not_found, 409 conflict,
                            // 422 invalid_input, 429 rate_limited, otherwise `http_<status>`
```

- A returned `Rejection` is a **successful delivery**: acked, not retried, not dead-lettered, replied with
  `{ ok: true, value: rejection }`. The trace shows `rejected <status>`. A Query returning one is still deduplicated.
- Only guards and handlers whose output is `rejectable(...)` may return one (tsc enforces it). Edges render it
  unchanged (§10.7). `null` is "not found" (`Model.nullable()`), never a rejection.
- Throw only when the operation did not happen: the bus retries, then dead-letters; the requester gets
  `RemoteError { cause }`.

### 3.5 Lists, cursors, conditional writes

- `Paging({ max = 100, default = min(20, max) })` returns a shape `{ limit: z.number().int().min(1).max(max)
  .default(default), cursor: z.string().nullable().default(null) }`, spread into a query input (`...Paging()`).
  Invalid bounds throw `invalid-schema` naming the allowed form `Paging({ max: 100, default: 20 })`.
- `Page(Model, { cursorField = 'next_cursor' })` returns `z.object({ data: Model.array(), [cursorField]:
  z.string().nullable() })` titled `Page(<Model>)`.
- `IfMatch`: a zod preprocess that reads an `If-Match` header: a quoted strong ETag `"7"` → `'7'`, `*` → `'*'`, absent
  → `null`; anything else fails with 'expected one strong ETag like "7", or *'. `etag(value)` quotes a value as a
  strong ETag. Edges pass `headers['if-match']` into the command; the domain compares versions and returns
  `reject(412, …)` on mismatch.
- Cursor encoding lives in `@murmur/node/lib` (§11).

## 4. Pieces (`murmur`, model half)

### 4.1 The class

```ts
export class Todos extends Piece({ needs: { db: sqlite, jobs }, config: { pageMax: z.number().default(100) },
  emits: [TodoCreated], policy: { timeoutMs: 10_000 } }) {
  private readonly todos = new TodoRepository(this.db);

  @Handle(CreateTodo)
  async create(input: CreateTodo, delivery: Delivery): Promise<Todo> { … }

  @Handle(SweepNotifications, { every: '1h' })
  async sweep(): Promise<void> { … }
}
```

`Piece(declaration?)` returns a base class. Every field is optional; `Piece()` is legal.

| Field | Puts on `this` / means |
| --- | --- |
| `needs: { field: token }` | `this.<field>` typed as the token's handle, started before construction |
| `config: { key: zodSchema }` | `this.config.key`, resolved by the config lane (§8.4), validated, frozen |
| `emits: [Event, …]` | the only events `this.emit` accepts (tsc, lint `emit-declared`, runtime `EmitNotDeclaredError`) |
| `policy: { concurrency?, timeoutMs?, retry?, requestTimeoutMs? }` | delivery policy for this piece (§5.6) |

Always present: `this.log`, `this.clock`, `this.ids`, `this.config`, `this.emit(Event, payload)`,
`this.request(RequestClass, input, { timeoutMs?, signal? })` → output (a `Rejection` when the output is rejectable).
`this.request` needs no declaration: its call sites are the declaration (the catalog reads them from source).

- No constructor, no `super()`. Field initialisers run after the capabilities started and may use `this.db`,
  `this.config`, `this.log` (`readonly #repo = new Repo(this.db)`). A throwing initialiser is
  `BootError { phase: 'construct' }`. `new Todos()` outside the runtime throws "pieces are constructed by the runtime,
  not with new"; tests use `testPiece`.
- One instance per process. Fields live as long as the process (a cache, an SSE client set); per-delivery facts come
  from `delivery` or `req`, never from fields.
- `PieceDefinitionError` at import: a reserved `needs` field (`log`, `clock`, `ids`, `config`, `emit`, `request`,
  `onStart`, `onStop`: "Piece({ needs }): X is a reserved field name; pick another"), a non-token `needs` value, a
  non-zod config value, a non-event or duplicate in `emits`, two `@Handle` for one contract, two `@Serve` with one
  binding or overlapping bindings in one piece, a decorator on the wrong target.
- The API behind `this` is a port resolved through the run context (`PieceApi` over `AsyncLocalStorage`), so the same
  instance serves concurrent deliveries.

### 4.2 `@Handle`

```ts
@Handle(C, options?: { retry?: { attempts: number; after?: Duration[] }; every?: Duration })
type Duration = `${number}s` | `${number}m` | `${number}h` | `${number}d`
```

- "The bus delivers `<wireName>` here." The first parameter is the validated input typed as the class; the return is
  the output, checked by tsc on the decorator line (`Reply<C>` with an `Exact` excess-key check: a wrong, missing or
  extra key, `undefined` for a nullable, is a compile error). A command whose output accepts `{}` may return nothing
  (the bus replies `{}`). Event listeners return nothing.
- The optional second parameter `delivery: Delivery` = `{ envelope, attempt, signal, piece }`: the envelope (its `id`
  is the idempotency key), the 1-based attempt, a signal aborting on handler timeout or shutdown, the piece id.
- One handler per contract per piece; the method name is free (`#private` works). Decorator arguments are static:
  imported classes and literals (`decorator-args-static`); decorators live only on piece classes
  (`decorators-in-pieces-only`).
- `every`: the handler is a schedule (§9.6); `retry`: the job retry ladder (§9.6). A bad option throws
  `PieceDefinitionError` at import and is a `murmur check` finding: `every-format` "`every: 'X'` is not a duration;
  use `<n>s`, `<n>m`, `<n>h` or `<n>d`"; `every-input` when the contract is not a command or has required fields ("a
  scheduled command takes none"); `retry-ladder` "a retry ladder applies to job Commands (policy.retry covers bus
  redelivery)", "`retry.attempts` must be a positive integer like `{ attempts: 5, after: ['30s', '5m'] }`",
  "`retry.after` entries must be durations like '30s'".

### 4.3 `@Serve`

- Method form: `@Serve(binding)` on an instance method `(req: WebRequest, delivery?: Delivery) =>
  Promise<HttpResult>`. Class form (shorthand): `@Serve(binding, Contract)` above the class forwards to a query,
  command or guard. Details in §10.
- `@Serve` without a contract on a class, or with one on a method, throws `PieceDefinitionError` naming the right
  place. The binding must come from an ingress token.

### 4.4 Lifecycle hooks

Optional methods `onStart()` and `onStop()` run once per process inside a run of the piece (so `this.emit`,
`this.request` and ALS-aware handles work): `onStart` after every piece subscribed, `onStop` after the last delivery
settled, in reverse registration order. A throwing `onStart` fails `runtime.start()`. A method named like a hook with
a typo (`onstart`, `on_stop`) is check finding `lifecycle-hook-typo`.

### 4.5 Runs and lost context

`this.emit`, `this.request`, `this.log` and ALS-aware handles find the current run through `AsyncLocalStorage`.
Handlers, serve methods, hooks and everything they `await` join it. Callbacks the async context does not follow (an
EventEmitter listener, an abort listener, a timer or watcher created outside a run, `ReadableStream` `cancel`/`pull`,
a socket handler) have no run: an emit or request there opens a **background run** for the piece (fresh trace,
`$sys.emit.background { piece, contract }`, labelled `background` in traces); nothing throws. A sqlite call there takes
the lock on its own. Keep such callbacks to bookkeeping.

### 4.6 Idempotency under redelivery

Every delivery may arrive twice; the second run must be a no-op keyed on `delivery.envelope.id`: a claim-first side
table (`INSERT OR IGNORE` of the envelope id in the same transaction as the write) when the reply must carry the same
id; a naturally idempotent write (`UPDATE … WHERE done = 0`); or `this.kv.once(delivery.envelope.id, effect)`.
Effects outside sqlite (`fetch`, `emit`) stay at-least-once; consumers dedupe on their own ids. A piece's `context.md`
states the invariant; a test delivers the same `envelopeId` twice.

## 5. Bus (`murmur`, runtime half)

### 5.1 Surface

```ts
createBus(options: { transport; context: ContextStorage<RunContext>; instanceId?; ids?; clock?;
  policy?: DeliveryPolicyInput; limits?: { warnBytes?; maxBytes?; maxHop? }; observability?: { payloads: boolean };
  mode?: 'dev' | 'prod'; sink?: (line: LogLine) => void; stacks?: { ingress?; capabilities? };
  localRequests?: boolean /* true */ }): Bus

interface Bus extends CapabilityBus, AsyncDisposable {        // CapabilityBus: emit, request, enter, stopping
  readonly instanceId: string;                                 // ids.short(), 8 chars [a-z0-9]
  readonly stats: { pendingRequests; inflight; internalDropped; observerDropped };
  register(piece: PieceRuntime): Promise<Registration>;
  observe(pattern, name, fn): Promise<Subscription>;
  invoke<R>(piece: string, init: InvokeInit, fn: EntryFn<R>): Promise<Awaited<R>>;
  portFor(piece: string): PiecePort;                           // the API behind this.emit / this.request / this.log
  policyOf(piece: string): DeliveryPolicy;
  stop(reason: string, options?: { graceMs?: number /* 10_000 */; forceMs?: number /* 2_000 */ }): Promise<void>;
}
```

`classPieceRuntime` turns a constructed piece class into a `PieceRuntime { name, handlers, emits, needs, configKeys,
policy, start, stop }`; the node runtime and the test helpers both go through it.

### 5.2 Registration

1. Validate the piece id and every handled wire name; one handler per name.
2. A request contract already answered by another registered piece → `DuplicateResponderError` (boot).
3. One subscription per piece: `transport.subscribe(names, group = piece id, dispatch, { prefetch: concurrency })`.
   The dispatcher selects the handler by `envelope.name`; an envelope with no handler → `NoHandlerError`,
   dead-lettered (`phase: 'no-handler'`), never requeued.
4. `registration.start()` runs `onStart` and publishes `$sys.piece.started`; the runtime calls it for every piece only
   after all pieces subscribed, so an `onStart` may request anything handled in the process.
5. Disposal = unsubscribe (intake stops); `registration.stop(signal)` runs `onStop` during shutdown (§5.9).

### 5.3 Dispatch (one delivery)

```
transport → dispatch(delivery)                         the whole body runs inside context.run(run, …)
  0 run = { traceId, eventId: id, hop, piece, deliveryId, attempt, signal, deadline?, internal, request? }
    ctrl = new AbortController(); timer aborts it with HandlerTimeoutError after policy.timeoutMs
  1 handler by envelope.name; none → NoHandlerError → 7
  2 validate input (consumer side); invalid → ContractViolationError → 7 at once (phase 'validate')
  3 $sys.delivery.received (not for $sys.* envelopes)
  4 result = race(handler(input, delivery), signal)
  5 success: await every emit started in this delivery (a rejected emit → failure, phase 'emit'; no reply sent)
            responder with replyTo → validate output → publish { ok: true, value } (failure → phase 'reply')
            ack; $sys.delivery.acked { durationMs, replied }
  6 failure: retryable && attempt < maxAttempts && (no deadline || deadline not passed)
            → $sys.delivery.failed { willRetry: true, phase }, $sys.delivery.retried { nextAttempt, delayMs }
              nack(true, { delayMs: backoff(attempt) }); a ShutdownError nacks with consumeAttempt: false
  7 terminal: $sys.delivery.deadlettered { envelope, attempts, error, phase, reason? }
            replyTo → publish { ok: false, error }; nack(false)
  finally: clear the timer, drop the controller from the in-flight set
```

- Backoff: `min(baseMs · 2^(attempt−1), maxMs) · (1 + jitter · (random·2 − 1))`. The attempt count is supplied by
  the transport, so it survives restarts on AMQP. Concurrency is only the transport `prefetch`.
- **Request-scoped retry**: a delivery that carries a `deadline` is never attempted again once the deadline passed;
  it dead-letters with `reason: 'requester-gone'` (also on `$sys.delivery.failed`).
- A returned `Rejection` is step 5 (success). Errors with `retryable: false` (`NonRetryableError`,
  `ContractViolationError`, …) go straight to 7.
- The handler promise is not cancelled on timeout or abort; it becomes a **zombie**: a late return is ignored, a
  late emit is published with `late: true`, a late throw is `$sys.delivery.zombie-failed`; zombies are awaited only at
  shutdown. A listener that returns a value gets `$sys.delivery.reply-ignored` once per piece (dev).
- Internal events are fire-and-forget, never awaited on the hot path, never throw (drops counted in
  `stats.internalDropped`). A `$sys.*` delivery produces no internal events; a failing one is acked and logged to the
  sink, never retried or dead-lettered; work done while handling one logs to the sink only.
- Per-delivery signal: a plain `AbortController` + timer, never composed with `bus.stopping`; shutdown aborts the
  in-flight controllers directly.

### 5.4 Request / reply

- Only responders reply. One reply subscription per bus, `$reply.<instanceId>` (exclusive), created on the first
  request. `request()` validates the input, publishes with `replyTo`, a fresh `correlationId` and `deadline = ts +
  timeout` (`mandatory: true`), waits up to `timeoutMs` (default the piece's `requestTimeoutMs`, 10 000) on a ref'd
  timer, then parses the reply against the output schema.
- Reply envelope: `name = replyTo`, copies `correlationId`, `causationId = request.id`, same `traceId`, `hop + 1`,
  `source = responder`, published non-persistent with `expiresMs = requestTimeoutMs`; exempt from `maxHop`.
  Wire payload `{ ok: true, value } | { ok: false, error: { name, message, code?, retryable } }`; a failure reply is
  sent only when the request is finally dead-lettered.
- Requester outcomes: the output (a `Rejection` is an output), `ContractViolationError` (local),
  `NoRouteError` (no responder; memory always, AMQP via `mandatory` + return), `RequestTimeoutError { name,
  correlationId, elapsedMs }`, `RemoteError { name, message, code, retryable, cause }`, `ShutdownError`, or the
  caller's abort. `request()` on an event throws `NotRequestableError`; it refuses locally with `CascadeDepthError`
  when the next hop would exceed `maxHop`.
- A late reply is `$sys.request.late-reply`, a second one `$sys.request.duplicate-reply`; both are dropped.

### 5.5 Per-trace query dedupe

A query request is shared with an identical one already in flight in the same trace: key `wireName \0 canonical JSON
(input)` (sorted keys), only for queries, only from inside a run (a parent context exists), only without a caller
`signal`, and only when the follower's `timeoutMs` covers the leader's remaining time. The follower awaits the
leader's promise (no envelope), `$sys.request.deduped { traceId, key, byPiece, firstEnvelopeId }` is published and the
leader's `$sys.request.completed` carries `deduped: <count>`. The entry is forgotten when the leader settles.
Commands, events and guards are never deduplicated.

### 5.6 Local shortcut and policy

- With `localRequests` (default on), a request whose responder is registered on this bus is dispatched in-process:
  same validation, policy, retries, run context, reply semantics and `$sys` events, no transport hop. Guards answered
  in-process therefore cost one function call plus validation.
- Policy defaults: `concurrency 8`, `timeoutMs 30_000`, `retry { maxAttempts 5, baseMs 200, maxMs 30_000, jitter
  0.5 }`, `requestTimeoutMs 10_000`. Effective policy = defaults < `defineApp({ policy })` < `Piece({ policy })` <
  yaml `pieces.<id>.$policy`; every field optional.

### 5.7 Ingress entries and background runs

- `bus.invoke(piece, { transport, binding, traceId?, payload?, signal? }, fn)` runs `fn(delivery)` as a local job of
  that piece: a run context (`this.emit`/`this.request`/ALS-aware handles work), the piece's timeout and abort signal,
  emits drained before it returns, `$sys.ingress.received { envelope }` / `completed { durationMs }` / `failed {
  error }`. The `received` envelope is named `$ingress.<transport>` with `payload` (`{ method, path, binding }` for
  http) and roots the trace.
- `bus.enter({ piece: 'external:<label>', traceId?, signal? }, fn)` opens a context without a delivery at hop −1, so
  its first emit is hop 0 and every emit inside shares one minted trace id.
- An emit or request from a piece outside any run opens a background run (§4.5).

### 5.8 Observers

`bus.observe(pattern, name, fn)` subscribes group `$observer.<name>.<instanceId>` (exclusive, prefetch 64, bounded
retention 10 000 / 60 s), acks before `fn` runs, runs `fn` inside its own internal run context, sends errors to the
sink and counts drops in `stats.observerDropped`. Observers never reply and never retry.

### 5.9 Shutdown (`bus.stop(reason, { graceMs, forceMs })`, idempotent)

1. `$sys.runtime.stopping { reason }`; `bus.stopping` aborts.
2. The ingress stack stops (servers stop accepting; job claiming ends).
3. Every piece unsubscribes (intake stops; queued items stay queued, at-least-once holds).
4. Wait for in-flight deliveries up to `graceMs`.
5. Abort the remaining controllers with `ShutdownError` (redelivered without consuming an attempt).
6. Wait for in-flight and zombies up to `forceMs`; then `onStop` per piece in reverse registration order, each with a
   signal that aborts after `forceMs`; `$sys.piece.stopped`.
7. Answer local in-flight requests, reject pending requests with `ShutdownError`, drop the reply subscription.
8. The capability stack stops (reverse start order).
9. `$sys.runtime.stopped { drained, forced, durationMs }`; `transport.close(signal)`.

Errors are collected per phase, sent to the sink, and the first is rethrown after all phases ran.

### 5.10 Run context

```ts
interface RunContext {
  readonly traceId: string;
  readonly eventId?: string;        // envelope being handled; children's causationId
  readonly hop: number;             // -1 inside bus.enter
  readonly piece: string;           // 'todos' | 'external:http' | '$observer.tail'
  readonly deliveryId?: string;     // process-local
  readonly attempt?: number;
  readonly signal: AbortSignal;
  readonly deadline?: string;
  readonly internal: boolean;       // handling $sys.* or observing: log to the sink only
  readonly request?: { correlationId: string; replyTo: string; replyAddress?: string };
}
```

`current()` (exported from `murmur` and `@murmur/node`) returns the run or `undefined`. The bus wraps every dispatch,
observer callback and reply handler in `context.run` with a store built from the envelope or pending entry, never
inherited from the transport callback. `emit`/`request` create child envelopes from `current()`.

### 5.11 `$sys.*` events

Every payload is a JSON object plus `instanceId` and `at`; internal envelopes carry the trace and hop of what they
describe and `source` = the piece involved. The schema is `SysPayloads` in `model/internal.ts`; `sysEvents` holds one
internal contract per name.

| Name | Payload |
| --- | --- |
| `runtime.started` | `{ pid, transport, pieces, capabilities, configSummary }` |
| `runtime.stopping` / `.stopped` | `{ reason }` / `{ drained, forced, durationMs }` |
| `piece.started` | `{ piece, group, handles: [{ name, kind: 'responder' \| 'listener' }], emits, needs, configKeys, policy }` |
| `piece.stopped` / `.failed` | `{ piece }` / `{ piece, phase: 'load' \| 'config' \| 'needs' \| 'subscribe', error }` |
| `capability.started` / `.stopped` / `.failed` | `{ name, durationMs }` / `{ name, phase: 'start' \| 'stop', error }` |
| `event.published` | `{ envelopeId, name, traceId, causationId?, correlationId?, hop, source?, bytes, late, local?, envelope? }` |
| `event.unrouted` | `{ envelopeId, name, source? }` |
| `delivery.received` | `{ deliveryId, envelopeId, name, piece, attempt, redelivered, traceId, deadline }` |
| `delivery.acked` | `{ …ref, attempt, durationMs, replied }` |
| `delivery.failed` | `{ …ref, attempt, durationMs, error, willRetry, phase: 'handler' \| 'emit' \| 'reply', reason? }` |
| `delivery.retried` / `.timeout` | `{ …ref, nextAttempt, delayMs }` / `{ …ref, attempt, timeoutMs }` |
| `delivery.deadlettered` | `{ deliveryId, envelope, piece, attempts, error, phase (+ 'validate' \| 'no-handler'), reason? }` |
| `delivery.reply-ignored` / `.zombie-failed` | `{ piece, name }` / `{ deliveryId, piece, error }` |
| `request.sent` | `{ correlationId, name, envelopeId, piece, traceId, timeoutMs }` |
| `request.completed` | `{ correlationId, name, piece, durationMs, ok, error?, deduped? }` |
| `request.deduped` | `{ traceId, key, byPiece, firstEnvelopeId }` |
| `request.timeout` / `.late-reply` / `.duplicate-reply` | `{ correlationId, name, piece?, timeoutMs? }` |
| `emit.background` | `{ piece, contract }` |
| `ingress.received` / `.completed` / `.failed` | `{ piece, transport, binding, traceId }` + `envelope` / `durationMs` / `durationMs, error` |
| `job.claimed` / `.succeeded` / `.failed` / `.dead` | `{ id, contract, piece, attempt }` + `groupKey?` / `durationMs` / `durationMs, error, nextRunAt` / `durationMs, error` |
| `log` | `{ level, msg, piece, traceId?, eventId?, deliveryId?, attempt?, fields?, error? }` |
| `transport.reconnecting` / `.reconnected` / `.error` | `{ transport, attempt?, error? }` |

`SerializedError = { name, message, code?, retryable?, stack? }` (`stack` in dev only). `$sys.event.published` carries
the envelope only with `observability.payloads` (dev on, prod off); `local: true` marks an in-process request.

### 5.12 Errors

Model half: `MurmurError { code, retryable }`, `NonRetryableError`, `ContractViolationError { contract, side:
'payload' | 'reply' | 'config', issues }`, `EmitNotDeclaredError`, `NotRequestableError`, `PieceDefinitionError`,
`LoadError`, `serializeError`. Runtime half: `CascadeDepthError`, `DuplicateResponderError`, `EnvelopeShapeError`,
`HandlerTimeoutError` (retryable), `NoHandlerError`, `NoRouteError`, `PayloadTooLargeError`, `RemoteError`,
`RequestTimeoutError`, `ShutdownError` (retryable, attempt not consumed), `TransportError`. Every class name ends in
`Error`; HTTP bodies never show class names (§10.7).

## 6. Envelope (`docs/envelope.md` is the user page)

```ts
interface Envelope<P = unknown> {
  readonly id: string;              // UUID v4; same id on every redelivery; the idempotency key
  readonly name: string;            // wire name, $sys.*, $reply.<instanceId> or $ingress.<transport>
  readonly traceId: string;         // ^[0-9a-f-]{8,64}$; a root has traceId === id unless an ingress supplied one
  readonly causationId?: string;    // id of the envelope whose handler emitted this one
  readonly correlationId?: string;  // request/reply pairing
  readonly replyTo?: string;        // present only on requests
  readonly deadline?: string;       // Temporal.Instant when the requester stops waiting; requests only
  readonly ts: string;              // Temporal.Instant string; informational, never for ordering
  readonly hop: number;             // 0 for a root, parent.hop + 1
  readonly source?: string;         // emitting piece id or external:<label>
  readonly payload: P;              // validated before publish; never undefined
}
```

- Eleven keys, nothing else: `parseEnvelope(json | bytes)` rejects unknown or missing keys and wrong types with
  `EnvelopeShapeError` and checks the `traceId` regex; it never checks a UUID version or the name grammar. There is no
  wire versioning, so an additive change is breaking.
- `createEnvelope({ name, payload, parent?, correlationId?, replyTo?, source?, ids, clock })`: `id = ids.uuid()`,
  `ts = clock.now().toString()`; with a parent run `traceId = parent.traceId`, `causationId = parent.eventId`,
  `hop = parent.hop + 1`; without one a root. The bus adds `deadline` to request envelopes.
- Encoding: `JSON.stringify`, UTF-8, no BOM, `undefined` omitted, table key order on write, any order on read. Size is
  measured once at publish: warn at `warnBytes` 64 KiB (`bytes` on `$sys.event.published`), reject at `maxBytes`
  1 MiB (`PayloadTooLargeError`); `hop > maxHop` (32) is `CascadeDepthError` (replies exempt). All three live in
  `defineApp({ limits })`.
- An ingress validates inbound trace ids (`x-murmur-trace` first, then the `traceparent` trace-id) against the regex
  and mints a fresh one otherwise, so untrusted input never reaches `parseEnvelope`. Outbound HTTP (the `fetch`
  capability) and every HTTP response carry `x-murmur-trace` and `traceparent: 00-<32 hex>-<16 hex>-01`.
- Exports: `createEnvelope`, `parseEnvelope`, `serializeEnvelope`, `validateName`, `validatePieceId`,
  `matchPattern` (cached RegExp), `isInternal`.
- The piece id's env form is upper-case with `/` and `-` turned into `_` (`api/rest` → `API_REST`).

## 7. Transports

### 7.1 Interface (`murmur`)

```ts
interface Transport {
  readonly name: 'memory' | 'amqp' | (string & {});
  readonly features: { orderedWithinGroup; detectsNoRoute; nativeRedelivery; directReply };
  publish(envelope, options?: { mandatory?; address?; persistent? /* true */; expiresMs? }): Promise<void>;
  subscribe(patterns, group, handler, options: { prefetch; exclusive?; retention?: { maxLength?; ttlMs? };
    signal? }): Promise<Subscription>;
  close(signal?: AbortSignal): Promise<void>;
}
interface TransportDelivery {
  readonly envelope; readonly attempt /* 1-based, transport-supplied */; readonly redelivered; readonly replyAddress?;
  ack(): Promise<void>;
  nack(requeue: boolean, options?: { delayMs?: number; consumeAttempt?: boolean /* true */ }): Promise<void>;
}
```

- `publish` resolves when accepted (memory: enqueued; AMQP: confirmed); rejects `NoRouteError` only when `mandatory`
  and the transport detects no route; never invokes a subscriber synchronously.
- Each group with a matching pattern gets one copy (fan-out across groups, competing consumers within one); one
  subscriber per group per process (a second subscribe rejects with `TransportError`).
- Every transport delivers what `parseEnvelope(serializeEnvelope(env))` yields, so a payload JSON cannot carry
  behaves the same everywhere.
- `ack`/`nack` are idempotent; `nack(true, { delayMs })` redelivers to the same group with `attempt + 1` unless
  `consumeAttempt: false`; `nack(false)` dead-letters. `close(signal)` cancels consumers, waits for in-flight until
  the signal, requeues the rest. The framework never deduplicates: handlers may see an envelope twice.
- Groups: piece `api/rest` → group `api/rest`; reply listener `$reply.<instanceId>` (exclusive); observer
  `$observer.<name>.<instanceId>` (exclusive, bounded). A shared conformance suite (`runTransportSuite`) runs against
  both transports.

### 7.2 `@murmur/transport-memory`

`createMemoryTransport({ latencyMs?, chaos? })`: per-group queues pumped asynchronously; features `orderedWithinGroup:
true`, `detectsNoRoute: true`, `nativeRedelivery: false`, `directReply: false`. Extras for tests and the dev server:
`idle()` (resolves when every queue is settled), `pause()`/`resume()`/`paused`, `deadLetters` (`{ envelope, group,
attempt }[]`), `stats { published, delivered, acked, nacked, queued, inflight }`, `inject(envelope, group, { attempt?,
redelivered? })`. Events stay inside one process: with several processes on the memory transport a subscriber in
another process never sees them (`event-crosses-process`, §8.5); cross-process durable work is a job.

### 7.3 `@murmur/transport-amqp`

`createAmqpTransport({ url, instanceId?, directReplyTo? (false), quorum? (false), heartbeatSec? (30), publishBuffer?
(1000) })` on amqplib with confirm channels. Topology: topic exchange `murmur.events`; durable queue per group
`murmur.q.<group with / → .>`; dead letters through the fanout `murmur.dlx` into `murmur.dead`; delayed retries through
the direct exchange `murmur.retry` into per-queue TTL queues `murmur.retry.<queue>.<tier>`, the delay rounded up to a
tier of `[250, 1000, 5000, 30000]` ms; observers `murmur.obs.*` and replies `murmur.reply.*` (exclusive), or
RabbitMQ direct reply-to (`amq.rabbitmq.reply-to`) with `directReplyTo: true`. The attempt travels in the
`x-attempt` header. A retry is published to `murmur.retry`, confirmed, and only then is the original acked. Reconnects back off `min(100 · 2^(n−1), 5000)` ms and publish
`$sys.transport.reconnecting/reconnected/error`.

## 8. Node runtime (`@murmur/node`)

### 8.1 App definition

```ts
export default defineApp({
  name: 'todo-api',
  transport: () => createMemoryTransport(),
  capabilities: [sqlite],
  processes: { api: { pieces: ['api/**', 'auth', 'todos', 'stats'], jobs: false }, worker: { pieces: ['notifier'] } },
});

interface AppDefinition {
  readonly name: string;
  readonly pieces?: string;                                     // pieces directory, default 'pieces'
  readonly transport: Transport | (() => Transport | Promise<Transport>);
  readonly capabilities?: Record<string, CapabilityToken> | readonly CapabilityToken[];   // built-ins the app uses
  readonly policy?: DeliveryPolicyInput;
  readonly limits?: { warnBytes?; maxBytes?; maxHop? } & SizeLimits;                    // wire limits + sizing caps
  readonly observability?: { payloads?: boolean };              // envelope on $sys.event.published (dev default)
  readonly processes?: Record<string, { pieces: readonly string[]; jobs?: boolean }>;
}
interface SizeLimits { ctxLargeTokens? /* 25_000 */; ctxWarnTokens? /* 40_000 */; ctxFailTokens? /* 80_000 */;
  pieceLines? /* 1_500 */; handlers? /* 20 */; contextLines? /* 120 */ }
```

`capabilities` lists built-ins only; app-local tokens under `capabilities/<name>/capability.ts` are discovered; one
name defined twice is a boot error. `log`, `clock`, `ids` are always injected and never listed.

### 8.2 Runtime

```ts
createRuntime(options: { root; app?; env?; configFile?; mode? /* MURMUR_ENV ?? 'dev' */; process?; policy?;
  signals? /* true */; tap? }): Promise<Runtime>               // discovers and validates; does not start
interface Runtime extends AsyncDisposable {
  readonly bus: Bus; readonly clock: Clock; readonly pieces: readonly LoadedPiece[];
  readonly capabilities: ReadonlyMap<string, unknown>; readonly report: BootReport;
  start(): Promise<void>; stop(reason?: string): Promise<void>;
}
```

Other exports: `defineApp`, `loadAppDefinition`, `migrate(root, env?)`, `current()`, `withTap(transport, onPublish)`
(the dev server's lossless publish tap), `BootFailedError` (carries the report), `formatReport`.

### 8.3 Boot

`createRuntime`:

1. **load**: import `murmur.config.ts`; discover `pieces/**/piece.ts`, `pieces/**/contracts.ts`, `contracts/**/*.ts`,
   `capabilities/*/capability.ts` (sorted, no tests, no `node_modules`); import errors are collected per file, never
   thrown.
2. **declaration**: `piece.ts` exports exactly one class extending `Piece(…)`; the piece id from the folder
   (`piece-id`); every handled contract is a contract class; contract identity (`contract-identity`); internal
   contracts used only inside their subtree (`internal-contract-scope`); `context.md` present with parseable
   frontmatter (`missing-summary` warning when `summary` is absent).
3. **process**: with `options.process`, keep the pieces matching that entry's globs (`process-unknown`: "process `x`
   needs defineApp({ processes: { x: { pieces: ['x/**'] } } }) in murmur.config.ts; without processes `murmur start`
   runs every piece" or "… is not in defineApp({ processes }); start one of api, worker"; `process-invalid`:
   "processes.x.pieces must list piece id globs, e.g. x: { pieces: ['x/**'], jobs: false }", or an entry that
   matches no piece).
4. **config**: per piece and per capability (§8.4), including `config-env-collision`.
5. **needs**: every `needs` value resolves to a started-or-planned capability ("needs.db: capability sqlite is not
   started"); capability cycles ("capability cycle: a → b → a").
6. **contracts** and routes: responder uniqueness, `binding-conflict`, `route-shadowed`, `guard-output-overlap`,
   `guard-order`, `guard-meta-unknown`, `guard-meta-invalid` (§10). The http capability refuses `idempotent-method`
   and `idempotent-scope` when it starts; `@Handle` option problems (`every`, `retry`) throw at import (§4.2).
7. Any error → `BootFailedError` with the `BootReport` (grouped by piece: file, phase, code, message, issue paths).
   Warnings never block.

`runtime.start()`: capabilities in dependency order (30 s each; a failure stops the started ones in reverse and fails
the boot; sqlite applies migrations when it starts) → construct every piece (**construct** phase; field initialisers
see started handles) → `bus.register` for every piece (**subscribe**) → `registration.start()` for every piece
(`onStart`, `$sys.piece.started`) → ingress capabilities open (`ingress.ready` resolves) → `$sys.runtime.started` →
signal handlers (SIGINT/SIGTERM → `stop`).

```ts
type BootPhase = 'load' | 'declaration' | 'config' | 'needs' | 'contracts' | 'construct' | 'subscribe';
type BootErrorCode = 'config-env-collision' | 'piece-id' | 'contract-identity' | 'internal-contract-scope'
  | 'binding-conflict' | 'route-shadowed' | 'guard-output-overlap' | 'guard-order' | 'guard-meta-unknown'
  | 'guard-meta-invalid' | 'process-unknown' | 'process-invalid';
type BootWarningCode = 'subscribed-never-emitted' | 'emitted-never-subscribed' | 'requested-never-handled'
  | 'config-key-unused' | 'capability-unused' | 'missing-summary' | 'clock-overridable-prod';
interface BootReport { ok; pieces: { name; file; errors; warnings }[]; errors: BootError[]; warnings: BootWarning[];
  catalog: Catalog }
```

### 8.4 Config lane

Piece config sources, highest first:

1. env `MURMUR__<PIECE>__<KEY>`: piece id upper-cased, `/` and `-` → `_`; key in SCREAMING_SNAKE
   (`MURMUR__AUTH__PER_MINUTE=100`)
2. env `MURMUR__<KEY>` (shared)
3. yaml `pieces.<id>.<key>`
4. yaml `shared.<key>`
5. the schema default

Capabilities: env `MURMUR__CAP_<NAME>__<KEY>`, yaml `capabilities.<name>.<key>`. Piece policy: yaml
`pieces.<id>.$policy`. Other env: `MURMUR_ENV` (`dev` | `prod`), `MURMUR_LOG_LEVEL`, `MURMUR_TRANSFORM`.

```yaml
pieces:
  auth:
    perMinute: 60
    $policy:
      timeoutMs: 5000
capabilities:
  sqlite:
    path: '${DATABASE_PATH:-./todo.db}'
  web:
    port: ${PORT:-3000}
```

- `murmur.yaml` is read as text, `${VAR}` / `${VAR:-default}` interpolated (a missing variable without default is an
  error), then parsed with the yaml **failsafe** schema: every scalar is a string, so yaml and env are identical
  inputs. Block style (a `${…}` inside a flow map does not parse).
- One coercion rule for every source: validate the raw string; on issues, if `JSON.parse` succeeds, retry with the
  decoded value; accept whichever validates. Nested yaml maps keep string leaves and coerce leaf by leaf.
- The frozen config is built once per piece. Two subjects mapping to one env variable is `config-env-collision`
  naming both. A yaml key no schema reads is `config-key-unused`.
- `murmur dev` and `murmur start` load `.env` then `.env.local` when present (or the `--env-file` list). Pieces never
  read `process.env` (lint `no-process-env`); contracts and config schemas never coerce.

### 8.5 Processes

`defineApp({ processes })` names subsets of pieces by piece-id globs; `murmur start <name>` / `murmur dev --process
<name>` / `createRuntime({ process })` boot one. No name boots every piece. `jobs: false` claims no jobs in that
process (its pieces may still enqueue). An ingress capability nobody serves in that process stays off (log `web not
started: <reason>`) unless `capabilities.web.healthz: true`. Static analysis checks what crosses processes on the
memory transport: `request-crosses-process` (error) "<piece> requests <C>, handled only in process `worker`; host the
handler in `api` too, or make the work a job (`this.jobs.enqueue`)"; `event-crosses-process` (warning) "<piece>
subscribes <C>, emitted only in `api`; on the memory transport events stay in one process; use `this.jobs.enqueue` for
cross-process work".

### 8.6 Loader (`@murmur/node/register`)

Every process that runs app code (the `dev` child, `test` and its workers, the describe worker behind `ctx`, `catalog`
and `check`) gets `--enable-source-maps --import <@murmur/node/register>?root=<app root>`; `murmur start` imports the
same URL in-process. The hook (`module.registerHooks`, in-thread) sends every `.ts`/`.mts` file under the app root and
outside `node_modules` through `@swc/core` (standard 2023-11 decorators, `using` lowered, import attributes kept,
inline source maps) and loads it as ESM; framework packages and dependencies load untouched. `MURMUR_TRANSFORM=esbuild`
switches to esbuild (installed by the app). The transform would compile `enum`/`namespace`/parameter properties;
lint (`erasable-syntax-only`) and `tsc` (`erasableSyntaxOnly`) forbid them. `@murmur/node/tsconfig.app.json` sets the
strict app compiler options (§15.3). Apps installed with pnpm 12 allow the `@swc/core` build in
`pnpm-workspace.yaml`.

### 8.7 Logging

`this.log.debug|info|warn|error(msg, fields?)` and `log.child(fields)`; each line carries `level`, `msg`, `piece`,
`traceId`, `eventId`, `attempt` from the run, goes to stderr (pretty in dev, JSON in prod) and is published as
`$sys.log` (outside internal runs). `MURMUR_LOG_LEVEL` filters (default `debug` in dev, `info` in prod). A piece that
logs more than 1000 lines in one second has `$sys.log` muted for 10 s, announced by one warn line; the sink still
writes.

## 9. Capabilities

### 9.1 Definition (`defineCapability` from `murmur`)

```ts
defineCapability({
  name: string;                         // unique per app; config under capabilities.<name> / MURMUR__CAP_<NAME>__<KEY>
  config?: z.ZodObject;                 // coerced like piece config
  needs?: readonly string[];            // names of capabilities this one starts after
  ingress?: boolean;                    // brings work in; planned even when no piece needs it
  emits?: readonly EventClass[];        // sent outside any binding: the catalog lists "(external: <name>)"
  requests?: readonly RequestClass[];
  docs?: string;                        // pasted into every brief of a needing piece; else a sibling capability.md
  start(ctx: CapabilityStart): Handle | Promise<Handle>;              // 30 s budget
  stop?(handle: Handle, signal: AbortSignal): void | Promise<void>;  // 2 s budget, reverse start order
  fake?(ctx: { root; pieceDir; clock; needs }): Handle | Promise<Handle>;   // what testPiece injects
}): CapabilityToken<Handle>

interface CapabilityStart { config; needs: Record<string, unknown>; bus: { stopping; emit; request; enter }; log;
  clock; ids; mode: 'dev' | 'prod'; signal; root: string; ingress?: IngressPort }
```

- The token is both the definition the runtime starts and the value a piece puts in `needs`; the handle type is
  inferred from `start` (`HandleOf<typeof token>`), no generated `.d.ts`. Built-ins are plain tokens (`sqlite()` is a
  type error).
- App-local tokens: `capabilities/<name>/capability.ts` (default export), discovered, imported as
  `#capabilities/<name>`; `capability.md` beside it is the docs page; tests in `capabilities/**/*.test.ts`.
- A capability is I/O or state, never a helper bag; shared pure code is `lib/`.
- Handles are resolved once, at construction; there is no per-delivery wrapper. A handle needing per-delivery facts
  reads `current()` at call time (**ALS-aware**) and designs for `undefined` (a callback outside any run).
- Docs page rules: what the handle is in one line, one concrete example of a return value (surprises included:
  integer booleans, `undefined` for no row), which errors are retryable, how to stay idempotent, config keys with
  defaults. When a brief shrinks, only the page's first H1 section and the `export interface <PascalName>` block
  survive.

### 9.2 Lifecycle

1. Plan: capabilities some loaded piece needs + every ingress capability + their `needs`; any other defined
   capability raises `capability-unused`. An ingress capability starts only when a loaded piece serves through it or
   needs it and its config `enabled` is not `false` (otherwise log `<name> not started: <reason>`). `enabled` is
   reserved for ingress capabilities: the framework reads it, the capability's schema never sees it.
2. Start in dependency order (stable by name), each bounded by 30 s (`$sys.capability.started { name, durationMs }`);
   a failure stops what started and fails the boot (`$sys.capability.failed`).
3. Construct pieces with the started handles; subscribe; run `onStart`.
4. Shutdown: ingress capabilities stop first with a drain budget (the longest piece timeout, at least 2 s) in their
   `stop` signal; the bus drains; every other capability stops in reverse start order (2 s each).

### 9.3 Ingress port

An ingress capability has binding makers on its token (returning `Binding { transport, key, capability, guards? }`;
core's `Serve`, the catalog and the conflict check key on `transport` + `key` only, so a new transport needs no core
change) and an adapter in `start` that reads `ctx.ingress`:

- `targets(transport)` → `{ piece, serve: { binding, get, contract }, instance() }[]`: `get(instance)` is the
  decorated method of a method binding; `contract` is set for a shorthand.
- `invoke(piece, { transport, binding, traceId?, payload?, signal? }, fn)` = `bus.invoke` (§5.7).
- The jobs lane: `ready` (resolves once pieces are subscribed), `jobTargets()` (local command handlers with their
  piece timeout, `retry` and `every`), `invokeLocal(contract, input, { id, attempt, signal })` (one run as an entry of
  transport `job`), `report('job.claimed' | 'job.succeeded' | 'job.failed' | 'job.dead', payload)`.
- An adapter runs the binding's guards inside the entry (one request each, in order, each with its `prior`) before
  reading the body or calling the method, answers the first `Rejection` itself, and validates inbound trace ids.

### 9.4 Default handles

- `log` (§8.7), stamped from the run.
- `ids`: `uuid()` (v4), `short()` (8 chars `[a-z0-9]`).
- `clock`: `now(): Temporal.Instant`, `zonedNow(tz?)`, `sleep(ms, signal?)`, and async `freeze(instant | string)`,
  `advance(ms)`, `clear()`. The system clock refuses the last three: "clock.freeze needs
  capabilities.clock.overridable: true in murmur.yaml (test environments only); the system clock cannot be moved".
  With `capabilities.clock.overridable: true` the frozen instant lives in the sqlite table `murmur_clock`, shared by
  every process on the file and read once per run (one run sees one instant); boot warns `clock-overridable-prod` in
  prod mode. Everything time-based (kv windows, job `runAt`, schedules, idempotency TTLs) reads this clock.

### 9.5 Built-ins (`@murmur/node/capabilities`)

**`sqlite`** (`Sqlite` handle; config `path` `:memory:` | bare path | `sqlite:./app.db` | `file:///srv/app.db`
relative to the app root, `busyTimeoutMs` 5000, `migrations` globs/files/dir replacing the default
`['pieces/**/schema.sql', 'migrations/*.sql']`):

- One `node:sqlite` connection per process behind an async mutex; file databases in WAL with `synchronous=NORMAL`;
  every transaction `BEGIN IMMEDIATE`; a locked file waits up to `busyTimeoutMs` before `database is locked`.
- `run(sql, ...params)` → `{ changes, lastInsertRowid }`; `get` → row or `undefined`; `all` → rows (plain objects
  keyed by column, integer booleans); `exec(sql)`; `insert(table, row)` → the primary key given, else
  `lastInsertRowid`; params are positional `?` (string, number, bigint, null, Uint8Array). All async.
- `row(Model, sql, ...params)` → decoded model or `null`; `rows(Model, sql, ...params)` → `Model[]`: INTEGER 0/1 → a
  `z.boolean()` field, JSON TEXT → `z.array/object/record` fields, other columns as is, extra columns dropped, a
  missing column throws naming it; column names equal field names (alias in SQL).
- `transaction(async (tx) => value)`: commit on return (its value is the result), rollback on throw. `this.db.*`,
  `kv.once` and `jobs.enqueue` of the same delivery, or awaited inside the callback, join it; a nested `transaction`
  joins the outer one (one commit, no savepoint). Work from another delivery waits until it ends. Outside a run each
  call takes the lock on its own.
- Migrations: each file applied once in path order, recorded by relative path in `murmur_migrations`, under
  `BEGIN IMMEDIATE`, so processes booting together apply each file once; run at sqlite start and by
  `murmur migrate` / `migrate(root, env?)` (exit 4 on a failing file). `murmur_*` tables belong to the framework.
- `SqliteError` wraps driver errors.

**`kv`** (needs sqlite; table `murmur_kv`; config `namespace` `app`): `get(key)` → JSON value | `undefined`;
`set(key, value, { ttlMs? })`; `delete(key)`; `once(id, effect)` → `{ first: true, value }` | `{ first: false }`
(marker and effect commit in one sqlite transaction; a throwing effect rolls the marker back); `incr(key, { windowMs })`
→ `{ count, resetAt: Temporal.Instant }`, one atomic fixed-window counter shared by every process on the file, window
`floor(now / windowMs)` on the runtime clock. `incr` writes the database on every call.

**`fetch`** (config `timeoutMs` 10 000): the platform `fetch`, aborting on the run signal or the timeout, adding
`x-murmur-trace` and `traceparent` from the run; non-2xx resolves.

**`jobs`** (needs sqlite; tables `murmur_jobs`, `murmur_schedules`; config `poll` true, `pollMs` 500, `concurrency`
8): §9.6. Registered automatically when a piece needs it or declares `every`.

**`http(options)`**: the ingress token factory, §10.

### 9.6 Jobs

- `await this.jobs.enqueue(Command, input, { runAt?, dedupeKey?, groupKey? })` → `{ enqueued: boolean }`. Inside
  `this.db.transaction` of the same delivery the row joins it: the job exists only if the write commits. `runAt` a
  `Temporal.Instant` (default now); `dedupeKey`: a second enqueue while a job with that key is pending is ignored (a
  running job may re-enqueue its own key); `groupKey`: jobs of one group run one at a time, in enqueue order.
- Every process that handles the command claims due jobs (`pollMs`, `concurrency` per process; none where the process
  entry says `jobs: false`) and runs the handler as an ingress entry (`$ingress.job`): `delivery.attempt` is the job
  attempt, `delivery.envelope.id` is stable per job.
- A throw retries by `@Handle(C, { retry: { attempts, after } })` (the last step repeats), else by the piece's
  `policy.retry`; after `attempts` the job is `dead` (kept). `NonRetryableError` is dead at once; a returned
  `Rejection` is a success. A claim older than the piece timeout is taken again. `$sys.job.claimed/succeeded/failed
  (nextRunAt)/dead`.
- `@Handle(C, { every: '1m' })` (`s`, `m`, `h`, `d`; no cron): the command takes no required input; one process per
  window enqueues it (`murmur_schedules`), so it runs once across processes.
- Stop: claiming ends, in-flight jobs get the piece timeout, unfinished claims return to pending.
- `jobs.drain()` runs every job due by the clock (schedules too) until none is left → `{ ran, failed, dead }` (this
  process); `jobs.counts()` → `{ pending, running, dead }`.

## 10. HTTP ingress and admission (`docs/ingress.md` is the user page)

### 10.1 The web token

```ts
// capabilities/web/capability.ts — the one `typeof` of an app
import { http, type RequestOf } from '@murmur/node/capabilities';
import { Authenticate, RateLimit } from '#contracts/auth';

const web = http({ guards: [Authenticate, RateLimit], log: (auth) => ({ user: auth.userId ?? null }) });

export default web;

export type WebRequest = RequestOf<typeof web>;
```

- `http({ name? = 'web', guards?, errors?, maxBodyBytes? = 1 MiB, responseHeaders?(auth), log?(auth) })` returns an
  ingress capability token with binding makers. `responseHeaders(auth)` adds headers to every response after
  admission passed; `log(auth)` adds fields to the one access line per request `access { method, path, status, ms,
  traceId, … }` (`auth` is partial: a route may skip a guard).
- Config (`capabilities.<name>.*`, `MURMUR__CAP_WEB__*`): `port` 3000, `host` 127.0.0.1, `trustProxy` false,
  `healthz` false, `enabled` true. The server listens only when a loaded piece serves through the token (or
  `healthz: true`). `GET /healthz` (GET, HEAD, open) answers `{ ok: true }` unless a piece serves that literal path;
  a param or wildcard route does not replace it. `runtime.capabilities.get('web')` → `{ url, port }`.
- The token is discovered like any app-local capability; `murmur.config.ts` lists only built-ins.

### 10.2 Bindings

`web.get | post | put | patch | delete(path, { status?, guards?, skip?, meta?, timeoutMs?, maxBodyBytes?,
idempotent? })` and `web.raw(method, path)`. Paths `/todos/:id`; a raw binding may end in `/*rest`; the query string
is not part of the key (`'GET /todos/:id'`). `HEAD` is answered by the `GET` binding without a body; `OPTIONS` lists
the served methods. At one depth a static segment beats `:param`, which beats `/*rest`.

### 10.3 Serve forms

```ts
@Serve(web.get('/todos'), ListTodos)
@Serve(web.post('/todos', { status: 201 }), CreateTodo)
@Serve(web.delete('/todos/:id', { status: 204 }), RemoveTodo)
@Serve(web.get('/stats', { skip: [Authenticate] }), GetStats)
export class RestApi extends Piece() {
  @Serve(web.patch('/todos/:id'))
  async rename(req: WebRequest): Promise<HttpResult> {
    const { params, headers, body } = await req.read({
      params: { id: z.string() },
      headers: { 'if-match': IfMatch },
      body: { title: z.string().min(1) },
    });
    const out = await this.request(RenameTodo, { ...params, ifMatch: headers['if-match'], ...body });

    return req.reply(out, { etag: (todo) => todo.version });
  }
}
```

- **Shorthand**: params < query < JSON body merged into the contract input (failures map like `req.read`, by the part
  that supplied the failing field), then `this.request(C, input)`; the output renders like a returned outcome. Every
  `:param` must be a field of the contract input (tsc via `Covers`, and `binding-param-not-in-input` "route K: path
  param :p is not a field of C input").
- **Method**: `req: WebRequest`, optional `delivery`, returns `Promise<HttpResult>`: a `Response` (sent as is), an
  output (200 JSON or the binding's `status`), a `Rejection` (rendered), `undefined` (204) or `null` (404
  `not_found`).
- A file reads "shorthands above the class, methods inside"; a method once a route needs a header, an etag or a
  second status.

### 10.4 `HttpRequest`

`method`, `url`, `path`, `params`, `query`, `headers`, `peer`, `ip`, `auth`, `traceId`, `signal`, `raw`, `read(parts)`,
`reply(outcome, options)`.

- `peer` is the socket address; `ip` is the first `X-Forwarded-For` entry when `trustProxy: true`, else `peer`.
- `read({ params?, query?, headers?, body? })` is the one way to read a request. Each part is a zod object or shape,
  read in that order; the first failing part answers with its `errors.input` mapping before anything is published.
  Failing `params`/`query` strings are retried JSON-decoded (`?done=false` satisfies `z.boolean()`); the query is
  strict (an unknown or repeated single-valued key fails; `z.array()` takes repeats); headers by lower-case name, a
  missing optional header is `null`; the body is read for POST/PUT/PATCH/DELETE: empty is `{}`, a non-JSON content
  type fails as `mediaType`, invalid JSON as `json`, a non-object as `body`. A `read` key that is not a path param
  is `binding-param-not-in-input` "route K: req.read params key `x` is not a path param; …".
- `reply(outcome, { status?, headers?, etag? })` is the one response tail: a `Rejection` renders with its status,
  code, details and headers; `null` 404; `undefined` 204; an object as JSON with `status` or the route's. `etag` is a
  value or `(body) => value`, sent strong; a GET/HEAD whose `If-None-Match` matches answers 304 with no body.
  Returning the outcome directly is the same without headers or etag.
- `auth` is the merged guard outputs, typed from the token (`Principal & Quota`). A route that changes guards names
  its auth: `req: HttpRequest<Quota>` after `skip: [Authenticate]`; tsc rejects a mismatch (`ExactRequest`). With
  every guard skipped `auth` is `undefined`.
- `signal` aborts when the client disconnects or the response was sent. `raw` is the web `Request`; taken before
  `read` it streams the unread body, still capped at `maxBodyBytes`.

### 10.5 Guards and admission

```ts
export class Authenticate extends Guard(Principal) {}
export class RateLimit extends Guard(Quota, { optional: [Authenticate] }) {}
export class Scope extends Guard(Grant, { after: [Authenticate], meta: { role: Role.default('viewer') } }) {}

@Handle(Authenticate)
async authenticate(input: Authenticate): Promise<Principal | Rejection> {
  const token = bearer(input.headers['authorization']);
  if (token === null) {
    return reject(401, 'missing bearer token');
  }

  return { userId: token, roles: [] };
}
```

- Guard input `{ transport, operation, headers, params, peer, ip, meta, prior }` (`operation` = binding key, headers
  lower-cased). Output: the model or a `Rejection` (`headers` such as `retry-after` go on the response).
- Order: the token's guards, then the route's `guards` extras, minus its `skip`; one request each, sequential, once
  per request; the first rejection answers and the rest do not run. Outputs merge onto `req.auth`. The body is read
  after admission (401 before 413).
- `after: [G]`: G must run first; its output is `input.prior`, typed and non-nullable. `optional: [G]`: runs first
  when the route keeps it; its fields are `| undefined` in `prior`. `PriorOf<after, optional>` types it.
- `meta`: a zod shape the routes fill (`web.patch('/items/:id', { meta: { role: 'member' } })`); the guard reads
  `input.meta` typed with defaults applied.
- Problems, thrown when the binding is made and reported as boot errors and `murmur check` errors:
  `guard-order` ("route K: Y runs before Z, which Y lists in `after`; reorder the token's guards, or make Z `optional`
  on Y"; "route K: Y lists Z in `after`, but the route does not run Z; add Z to the token's guards before Y, or
  declare Z in Y's `optional`"; "route K skips Z but keeps Y, whose `after` names Z; skip Y too, or declare Z in Y's
  `optional`"; "route K: Y runs before Z, which Y lists in `optional`; reorder the token's guards so Z runs first"),
  `guard-meta-unknown` ("route K: meta key `k` is read by no kept guard; the kept guards accept …"),
  `guard-meta-invalid` (a meta value the guard's shape rejects), `guard-output-overlap` ("A and B both put f on
  req.auth (…); rename a field in one of the guard models").
- A refusal is an acked delivery: the trace shows `rejected 401`, nothing is dead-lettered, the method never ran. A
  guard that throws is broken: retried, dead-lettered, 502.
- Never request a guard from a serve method: `guard-requested-directly` "`this.request(G)` in a serve method;
  admission belongs on the route: `web.get('/x', { guards: [G] })`". Guards answered in-process take the local
  shortcut (§5.6).
- `bearer(header)` from `@murmur/node/lib`: the token of `Bearer <token>`, else `null`.

### 10.6 Idempotent routes

`web.post('/orders', { status: 201, idempotent: { scope: ['auth.userId', 'ip'], ttlMs?: 86_400_000, header?:
'idempotency-key' } })`.

- No key header: the method runs plainly. A key that is not 1–255 printable ASCII fails as the `headers` input part.
  The scope is the first listed path (`auth.*`, `ip`, `peer`) with a value; with none the method runs plainly.
- One `BEGIN IMMEDIATE` claim on the app database (`murmur_idempotency`; the token then needs sqlite): a new key runs
  the method; a key still running answers `errors.idempotency.inProgress` (default 409 `conflict`) until the piece
  timeout, after which the next retry takes it over; a finished key with a different request (sha256 of route, path,
  sorted query, canonical JSON body) answers `errors.idempotency.reused` (default 422 `invalid_input`); the same
  request replays the stored status, method headers and body plus `Idempotent-Replayed: true`, with fresh
  `responseHeaders` and trace headers.
- A 2xx is kept for `ttlMs`; another status or a throw keeps no row. A 2xx over `maxBodyBytes` or an event stream is
  answered but not kept. Expired rows are deleted on the next claim.
- `idempotent-method` "route K: `idempotent` applies to POST/PUT/PATCH/DELETE on non-raw routes; drop it or change
  the method"; `idempotent-scope` "route K: scope `p` does not resolve against this route's auth type; available:
  …" (or "scope is empty"). Both refuse the start and are `murmur check` errors.

### 10.7 Errors

Bodies carry a stable `code` and the `traceId`; class names never appear:
`{ "error": { "code": "not_found", "message": "nothing found at /todos/nope" }, "traceId": "1f3c…" }`.

| Cause | Status | `code` |
| --- | --- | --- |
| `read` params | 404 | `not_found` |
| `read` query, headers, json, body | 400 | `invalid_input` |
| body with a non-JSON content type | 415 | `unsupported_media_type` |
| a returned `Rejection` | as set | as set |
| a returned `null` | 404 | `not_found` |
| body over `maxBodyBytes` | 413 | `payload_too_large` |
| no responder for a requested contract (`NoRouteError`) | 501 | `not_implemented` |
| a domain handler or guard threw (`RemoteError`) | 502 | `upstream_failed` |
| request or handler timeout | 504 | `timeout` |
| anything else thrown in the edge | 500 | `internal` |

- `errors.input` overrides per part (`{ body: { status: 422, code: 'validation_failed' } }`) and renames zod issue
  codes (`issueCodes: { too_small: 'too_short' }`); issues keep zod's params (`{ path, code, message, origin, minimum,
  inclusive }`) and a refinement's `params` are spread in. `errors.envelope({ code, message, issues, details })`
  shapes the body; `errors.status` maps an uncaught error by `error.name`; `errors.idempotency` sets the two
  idempotency answers.
- 5xx bodies carry `cause: { name, message }` under `murmur dev` only. A client that leaves mid-request gets a
  bodiless 499 and a debug line.

### 10.8 Families, conflicts, shadowing

An edge owns route **families** (first static segment). `binding-conflict` (boot and check error): equal keys after
normalising params, naming both pieces. `route-shadowed` (error): a static route in one piece under another piece's
`:param`. `route-family-split` (warning): two pieces serve one family on one transport; the piece with most routes is
named owner. A new route in an existing family goes into the edge that owns it; a new family goes into the existing
edge unless it has its own lifetime or failure mode (an SSE feed).

### 10.9 Streaming, SSE, raw

Any method may return `new Response(readableStream, { headers })`; the adapter pipes it unbuffered. SSE is that with
`content-type: text/event-stream`: a `Set` of stream controllers on the piece, added on connect, removed on
`req.signal` abort, fanned out from `@Handle` listeners with `enqueue` wrapped in `try/catch`. The entry ends when the
method returns the `Response` (`$sys.ingress.completed` then; the stream outlives it). Clients are per process.
`web.raw('POST', '/uploads/:bucket')` gives an unread `req.raw.body`, no limit, no coercion, and must return a
`Response`.

### 10.10 In the trace

An HTTP request is one trace rooted at `$ingress.http { method, path, binding }`; the guard requests are its first
children, then whatever the method requested. A guard reply that is a `Rejection` reads `rejected 401` (JSON
`reply.rejected`).

## 11. The lib lane

- `lib/<module>.ts` holds shared pure code (formatting, codecs, row types, etag helpers), imported as
  `#lib/<module>`, tested by `lib/<module>.test.ts`. Lint `lib-pure`: imports only `node:*` modules without I/O,
  `zod`, `murmur`, `@murmur/node/lib`, `#contracts/*`, `#lib/*`; no top-level `let`; I/O and state go to a
  capability.
- `murmur new lib <name>` scaffolds the module and a test; `murmur ctx lib/<module>` prints a header, `## Signatures`
  and `## Tests`; a piece importing `#lib/x` gets `## Lib` with its signatures in its brief.
- `@murmur/node/lib` (pure helpers shipped with the framework): `bearer(header)` → token | `null`;
  `canonicalJson(value)` (sorted keys); `sha256(data)` → hex; `cursor.encode(binding, position)` → opaque string and
  `cursor.decode(binding, raw | null, PositionSchema)` → position | `null` (no cursor) | `Rejection` 400
  `invalid_cursor` "cursor is not one this list issued; start again without a cursor". A cursor is base64url JSON
  `{ p, c }` where `c` is the first 16 hex of `sha256(binding + "\n" + canonicalJson(p))`, so a cursor from another
  list or a tampered one is refused. Lists are keyset-paged: `ListTodos { ...Paging() }` → `Page(Todo)`.

## 12. Testing (`@murmur/node/testing`, `murmur/testing`)

### 12.1 `testPiece`

```ts
await using t = await testPiece(Todos, { needs?, config?, auth?, now?, id? });
const todo = await t.deliverJson(CreateTodo, createTodo);
assert.deepEqual(t.emitted(TodoCreated), [{ id: todo.id, title: 'buy milk' }]);
```

- Constructs the piece like the runtime (field initialisers, config through the lane with `config` overrides) and
  fakes every need left out of `needs` (a passed one wins): `sqlite` → `fakeSqlite({ schema: 'app' })`, `jobs` → rows
  on that sqlite (joins the delivery's transaction), `kv` → `fakeKv(clock)`, `fetch` → refuses until
  `fakeFetch(handler)` is passed; an app capability uses its `fake`, else the test must pass it ("testPiece: P needs
  f (name), which has no fake; pass it in options.needs ({ needs: { f: … } }) or give the capability one:
  defineCapability({ …, fake: ({ clock }) => handle })").
- `TestPiece`: `piece`, `needs.<field>`, `log`, `ids` (`issued`), `clock` (frozen at `now`; `await
  t.clock.advance(ms)`), `start()`/`stop()` (hooks), `deliver(C, input, { attempt?, traceId?, envelopeId? })` (a real
  async context; the same `envelopeId` twice is a redelivery), `deliverJson(C, json)` (fixtures as-is),
  `emitted(C?)`, `requested(C)`, `respond(C, fn)` (answers `this.request(C)`), `enqueued(C)` → `[{ input, options }]`,
  `runJobs()` → `{ ran }` (due jobs this piece handles), `fetch(request, { auth })` (drives one binding of this piece
  without guards; shorthands forward to `respond`ers), `await reset()` (forgets emits, requests, log, jobs).
- `fakeSqlite({ schema: 'app' | 'own' | string[], root?, pieceDir? })`: `:memory:` with the app's migration list,
  this folder's `schema.sql`, or a file list. `fakeKv(clock?)`, `fakeFetch(handler)`.
- `murmur/testing` (zero deps): `fakeClock(start = '2026-01-01T00:00:00Z')`, `fakeIds()`, `fakeLog()`,
  `fakeContextStorage()`.

### 12.2 Several pieces in memory

`createTestRuntime({ pieces: Record<id, PieceClass>, capabilities?, config?, transport?, policy?, now? })` boots the
given pieces on a memory transport: `bus`, `transport`, `clock`, `ids`, `log`, `emit(E, payload)`, `request(C, input)`,
`fetch(request)` (through the configured edges), `idle()`, `emitted(E)`, `events(pattern)`, `deadLetters()`.
`loadSubtree(dir)` returns `{ id: PieceClass }` for every `piece.ts` under a folder, for group `scenario.test.ts` files.
`runInContext(run, fn)` runs `fn` inside a run context (`{ traceId, piece, deliveryId, attempt, signal }`, defaults
filled) so an ALS-aware handle sees a delivery.

### 12.3 The whole app

`await using app = await createTestApp({ root?, process?, env?, tap? })` finds the app from the test file, boots every
piece (or one process) over real HTTP on port 0 with a temp migrated sqlite file, guards included, the overridable
clock on and job polling off: `app.url`, `app.fetch(path, init)`, `app.db`, `await app.clock.freeze(instant)`,
`await app.jobs.drain()`, `app.runtime`, `await app.reset()` (app rows, jobs, schedules, idempotency rows, kv counters
and once markers, the clock override; `murmur_migrations` stays), `stop()`. Admission (401/429, `meta`, idempotent
replays) and cross-piece flows are tested here.

### 12.4 Conventions

One test per handler, one failure path, one redelivery (same `envelopeId` twice). `fixtures/*.json` double as `murmur
emit --fixture` payloads. Tests run under `node --test` with the app loader (`murmur test`). A missing piece test is
catalog warning `missing-tests`.

## 13. CLI (`@murmur/cli`, bin `murmur`; `docs/cli.md` is the user page)

### 13.1 Global

```
murmur <command> [args] [flags]
global: --cwd <dir>  --json  --no-color  --env-file <path>  -q/--quiet  -h/--help  -V/--version
```

| Exit | Meaning |
| --- | --- |
| 0 | ok |
| 1 | findings: failed tests, `check` errors, `ctx` over the fail cap, `catalog --strict` warnings, files exist |
| 2 | usage: unknown command/flag, bad value, unknown piece or trace, no app root |
| 3 | no dev server running (live commands) |
| 4 | the app does not boot or cannot be described |
| 5 | internal error, Node < 26, `murmur dev` already running for this root |

- The app root is found by walking up to `murmur.config.ts` (or `--cwd`). `--json` prints one JSON object per line,
  each with a `kind` (`ctx`, `check`, `catalog`, `test`, `trace`, `emit`, `doctor`, `error`); errors are
  `{ kind: 'error', code, message, hint? }` in JSON mode, else `murmur: <message>` + `hint:` on stderr.
- Static commands (`catalog`, `ctx`, `check`, `new`, `test`, `doctor`) read the app on disk; analysis imports app code
  only in a forked describe worker. Live commands (`tail`, `trace`, `emit`) talk to a running `murmur dev`.

| Command | What |
| --- | --- |
| `dev` | supervise the app in a child, watch files, serve the dev protocol and UI |
| `start [<process>]` | boot the app in prod mode in-process until SIGINT/SIGTERM |
| `migrate` | apply the sqlite migration list once, exit 4 on a failing file |
| `tail` | stream envelopes |
| `trace <id>` | waterfall of one trace |
| `emit <Contract>` | publish or request through the dev server |
| `catalog` | contracts, pieces, routes, capabilities, warnings |
| `ctx <id>\|lib/<m>` | the agent brief for one piece, group or lib module |
| `check [paths…]` | structure + routes + lint + oxfmt (+ types) |
| `new piece\|contract\|lib\|app` | scaffold |
| `test [piece\|glob…]` | `node --test` on app tests |
| `doctor` | environment report |

### 13.2 `dev`, `start`, `migrate`

- `murmur dev [--port 4242] [--host 127.0.0.1] [--open] [--no-ui] [--no-watch] [--watch-tests] [--process <name>]
  [--replay 5000] [--redact] [--payload-cap 16kb] [--trace-dir .murmur/traces] [--inspect]`: runs the app in a child
  (dev mode), restarts it on changes, serves the dev protocol (§14) and the UI, writes `.murmur/dev.json` while
  running. A boot failure is printed and the watcher keeps going. A signal to the murmur pid drains the child
  (2 s + 0.5 s, SIGKILL at 3.5 s).
- `murmur start [<process>]`: the started process is the runtime (no child): registers the loader in-process, loads
  env files, boots in prod mode, prints `murmur start  pieces=N pid=P [process=x]`; SIGINT/SIGTERM stops it
  gracefully and exits 0; a boot failure prints the report and exits 4.
- `murmur migrate`: `migrate(root, env?)`, the same list and locking the sqlite capability applies at start.

### 13.3 `tail`, `trace`, `emit`, `doctor`

- `tail [--piece <glob>] [--contract <glob>] [--trace <id>] [--failed] [--internal] [--since <seq|duration>]
  [--no-follow] [--payload]`: `--internal` includes `$sys.*`; `--failed` keeps failed deliveries and dead letters; a
  job run prints as `job <contract> → <piece>`.
- `trace <traceId|prefix> [--from <file|dir>] [--payload] [--width 100]`: envelopes, deliveries with attempts and
  outcome, replies, dedupe notes, `rejected <status>`, `background` roots; from the dev server, then
  `.murmur/traces/` or `--from`. Exit 2 for an unknown or ambiguous id (candidates listed), 3 when nothing is found
  and no dev server runs.
- `emit <Contract> [--payload '<json>' | --fixture <file>] [--request] [--timeout 5000]`: through `POST /api/emit`;
  prints `traceId=… envelopeId=… Nms` and the reply.
- `doctor`: Node ≥ 26, TypeScript mode, pnpm, the app root, installed framework/tool versions, the dev lock (`none |
  live | stale`), `.oxlintrc.json` `extends` resolution, the active transformer with a probe transform of a
  decorated class, the register URL. Exit 1 when Node, the root, the lint config or the probe is wrong.

### 13.4 `catalog`

`murmur catalog [--format table|json|md|mermaid] [--strict] [--group <prefix>] [--contract <name>]` derives the
catalog from code (static analysis of class pieces, decorators, call sites, bindings): contracts with `emitters`
(events), `requesters` (call sites, shorthand routes, guards as `(<token> defaults)`) and `handlers`; pieces with kind
`domain | edge | mixed`; routes with effective guards; capabilities with users; warnings `subscribed-never-emitted`,
`emitted-never-subscribed`, `requested-never-handled`, `missing-context-md`, `missing-summary`, `missing-tests`,
`orphan-contract`, plus the route and guard codes. Exit 4 on catalog errors, 1 with `--strict` on warnings. Mermaid
groups edge pieces per http token and draws guard edges dashed. Every run (and every `dev` analysis) writes the lane
snapshot `.murmur/catalog-snapshot.json`.

### 13.5 `ctx`

```
murmur ctx <id>|lib/<module> [--with code,tests,fixtures,neighbors|all] [--budget <tokens>] [--format md|json]
           [--withhold-code] [--out <file>]
```

Sections in order: header (piece id, kind, commands to run from the app root: `pnpm exec murmur test pieces/<id>`,
`pnpm exec murmur check --fix pieces/<id>`, `pnpm exec murmur check pieces/<id>`; an import skeleton of what the piece
may import), `## Rules`, the context chain (ancestor group `context.md`s), own `context.md`, `## Files` (every file of
the folder with lines and token estimate, ending "Read the files the task touches; the brief carries what the folder
cannot tell you."), `## Code` (with `--with code`), `## Storage` (DDL of the tables the Needs lane names, with source
and one example row), contracts (zod source of every contract the piece handles, emits, requests or serves), `## Lib`,
`## Serves` (routes with guards, token defaults, `WebRequest`, the error table), catalog rows, capability docs (per
need: `### <field> (<name>)`, the docs page, the handle interface; plus `### tests: testPiece, createTestApp`),
config keys (env var and yaml path, never values), then tests, fixtures, neighbors when asked, and the footer.

- Tokens are `ceil(chars / 4)`. Sizing is judged on the full brief (every section, code and tests included) whatever
  is printed: footer `tokens: <printed> printed, full <N> (<tier>); tiers large ≥ 25000, warn ≥ 40000, fail ≥ 80000`
  and a `- not printed:` line naming left-out sections and the flag that adds them. At warn one stderr line names the
  size and the heuristics page (exit 0); at fail the brief is printed and the exit is 1.
- `--budget N` shrinks sections by priority (private files over 300 lines shrink to signatures first; `serves` and
  `lib` are kept longest) and skips the caps; `--budget 0` means no shrinking, no caps.
- `--withhold-code` drops `piece.ts` and private files (a regeneration brief). A folder with `context.md` or tests but
  no `piece.ts` (a **leaf under regeneration**) gets that brief automatically; its lanes come from the catalog
  snapshot, then `context.md` lane lines, then the tests (`t.deliver` → handles, `t.emitted` → emits, `t.respond` →
  requests, `t.fetch` → serves, `needs: { … }` → needs), each source named in the header.
- `--format json` → `{ kind: 'ctx', piece, sections: [{ id, title, tokens, level, text }], tokens, fullTokens, budget,
  overBudget, sizing, limits, error, regeneration }`. ctx never imports a class `piece.ts`.

The rules section, verbatim (`packages/cli/src/analysis/context-rules.ts`):

1. A piece talks to other pieces only through contracts on the bus; never import another piece folder; other pieces'
   code is off limits, even for idioms: read context.md files and contracts only.
2. `piece.ts` exports one class, `export class X extends Piece({ needs: { db: sqlite }, config, emits: [SomeEvent]
   })` (`Piece()` when it has none); logic goes to private files in the folder.
3. `@Handle(C) async m(input: C): Promise<Out>`: the parameter is the contract instance, the return is the output;
   add `delivery: Delivery` only when you need the envelope id, attempt or signal.
4. `this.emit(E, payload)` only for events in `emits`; `this.request(C, input)` for any query or command (the call
   site is the declaration). On the memory transport events stay in one process; cross-process durable work is
   `this.jobs.enqueue(Command, input)` inside the transaction.
5. A business refusal is a returned `reject(status, message, { code, details })`: in a guard, or in any handler whose
   contract output is `rejectable(...)`. The edge renders it unchanged. `null` is not found. Throw only when the
   operation did not happen: it is retried, then dead-lettered; `NonRetryableError` when a retry cannot help.
6. Client retries: `idempotent: { scope }` on the route. Bus redelivery: key every effect on `delivery.envelope.id`
   (`this.kv.once(delivery.envelope.id, effect)` or a claim-first `INSERT OR IGNORE` side table); emits stay
   at-least-once. Durable or delayed work: `this.jobs.enqueue(C, input, { runAt, dedupeKey, groupKey })`, never a
   timer; periodic work: `@Handle(C, { every: '1m' })`.
7. Edges read with `const { params, query, headers, body } = await req.read({...})`, call one contract, and answer
   with `req.reply(outcome, { status, headers, etag })` or return the outcome. Admission is the route's guards and
   `meta`; never request a guard from a serve method. Domain pieces know no transport.
8. Config from `this.config`, I/O through the `needs` handles (`this.db`, …), `this.log`, `this.clock`, `this.ids`;
   never `process.env`. Transactions: `await this.db.transaction(async (tx) => …)`; a nested call joins. Field
   initialisers may use `this.db` / `this.config` / `this.log` (`readonly #repo = new Repo(this.db);`); `new X()` of
   the piece outside the runtime throws, tests use `testPiece`.
9. Return plain objects that satisfy the model type, never `new Model(…)`; no `typeof` types in piece code, name the
   class.
10. Style: every `if`/`for`/`while` body in braces; every statement ends with `;`; a blank line around blocks, after
    a run of two or more consts and before `return` unless it is the only statement; a single one-line `const` (even
    `const x = await …;`) stays attached to the block that reads it (no blank line between `const row = await …;`
    and `if (row === undefined) {`); a multi-line `await` statement is its own paragraph, one-line awaits group
    without blank lines; exported functions and class methods declare their return type; no `any`, no `!`; no
    statement ternaries, no `cond && call()`, no nested ternaries; no comments in bodies (knowledge goes to
    `context.md`).
11. One concept, one owner of its storage; ctx tiers large 25k / warn 40k / fail 80k tokens, ~1,500 lines, ~20
    handlers; heuristics in `<path to piece-authoring.md>`:
    1. describable in one sentence without "and"
    2. one writer of each table; readers declare the table in context.md
    3. things that change together live together
    4. handlers sharing no state or helpers are a split smell
    5. start coarse, split on pain, never speculatively
12. Shared pure code lives in `lib/` and is imported as `#lib/x`; a capability is I/O or state, never a helper bag.

### 13.6 `new`

```
murmur new piece <path> [--handles C[,…]] [--emits C[,…]] [--needs field=cap[,…]] [--config key:type[,…]]
                        [--serve '<verb> /path[=Contract]'[,…]] [--edge] [--idempotent] [--summary "…"] [--dry-run] [--force]
murmur new contract <ClassName> --domain <file> --kind query|command|event|guard [--input key:type,…]
                    [--output key:type,…|Model|Model?|Model[]] [--name <wire>] [--dry-run]
murmur new lib <name> [--dry-run] [--force]
murmur new app <dir> [--transport memory] [--registry <url>]
```

- `piece` writes `context.md` (frontmatter, sections and lane lines `Handles:`, `Emits:`, `Requests:`, `Serves:`,
  `Needs:`, `Storage:`), `piece.ts` (one `@Handle` per handled contract with a typed stub; a guard answers `Out |
  Rejection` and refuses without an `authorization` header; `--idempotent` adds `delivery` and a claim-first table),
  `piece.test.ts` (`await testPiece(Class)`, `t.fetch` for routes, `t.respond` for requests), an empty `schema.sql`
  with `--needs db=sqlite`, and group `context.md`s for new parents. `--serve 'get /x/:id'` writes the method form,
  `'post /x=CreateX'` the shorthand. Samples follow the contract's JSON Schema. The scaffold starts green and
  formatted; exit 1 if `piece.ts` exists without `--force`.
- `contract` appends `export class X extends Query|Command|Event|Guard(…) {}` to `contracts/<domain>.ts` (`X?` →
  `.nullable()`, `X[]` → `.array()`); a dotted or non-PascalCase name is a usage error.
- `app` creates an app (memory transport) with `README.md`, `capabilities/web/capability.ts` (`http({ guards: [],
  errors: { input } })` + `WebRequest`), the three `#` import maps, the lint preset, the pnpm `allowBuilds` entry and,
  with `--registry`, an `.npmrc`. Human output ends with `next: <command>` lines (`next` in JSON).

### 13.7 `check`

`murmur check [--changed] [--types] [--fix] [--json] [paths…]` = structure and route findings + oxlint (the app's
`.oxlintrc.json` as is, else the `@murmur/lint` preset) + `oxlint --type-aware -c @murmur/lint/type-aware` + `oxfmt
--check` (`oxfmt/format` per unformatted file, `oxfmt/run` when oxfmt cannot run) + `tsc` with `--types`. Paths scope
it to pieces (a path under `contracts/`, `capabilities/` or `lib/` checks the whole app); `--changed` adds files
changed against `HEAD` plus untracked files; a route finding is in scope when any piece it names is. `--fix` formats,
applies lint fixes, formats again. JSON `{ kind: 'check', ok, findings: [{ rule, severity, file, line, col, message,
help?, pieces? }], summary: { structure, lint, types } }`. Exit 1 on any error (sizing findings are warnings), 4
when the app cannot be described. A folder that passes `check` passes the app's `pnpm lint`.

| Finding | Sev | Message / meaning |
| --- | --- | --- |
| `context-md-missing`, `context-md-frontmatter` | error | a piece without `context.md`; unparseable frontmatter |
| `missing-summary` | warn | frontmatter without `summary` |
| `piece-id` | error | folder name outside the piece-id grammar |
| `piece-class-missing` | error | "<id>: piece.ts has no exported class extending Piece(…)" / "export the piece class (export class X extends Piece(…))" |
| `piece-exports-one-class`, `one-piece-per-folder` | error | one class per `piece.ts`, one piece per folder |
| `group-folder-files` | error | a group folder holds only `context.md`, `contracts.ts`, `scenario.test.ts` |
| `folder-local-files` | warn | a file outside the allowed piece folder layout |
| `piece-import`, `contract-import` | error | a piece or contract file that fails to import in the describe worker |
| `handler-unknown-contract` | error | "<id> handles X, which is not a contract class imported from #contracts/* or an ancestor contracts.ts" |
| `handler-contract-unexported` | error | "<id> handles C, which is not exported from contracts/*.ts or an ancestor contracts.ts" |
| `internal-contract-scope` | error | an internal contract used outside its subtree |
| `wire-name`, `wire-name-mismatch` | error | an invalid derived name; static and runtime names disagree |
| `contract-json-schema` | error | `jsonSchema()` throws (a non JSON-faithful schema) |
| `emit-undeclared` | error | "this.emit(C) but C is not in the emits of Piece({ … })" |
| `needs-unknown` | error | "<id> needs "x" but no capability "x" is defined" |
| `needs-unchecked` | warn | needs not checked because `murmur.config.ts` does not import |
| `lifecycle-hook-typo` | warn | "X.onstart looks like the lifecycle hook onStart; the runtime calls onStart only" |
| `binding-param-not-in-input` | error | a `:param` missing from the shorthand contract input, or a `read` params key that is no path param |
| `serve-unresolved` | error | "<decorator>: <problem>; check, catalog and ctx cannot see this route" |
| `binding-conflict`, `route-shadowed` | error | §10.8 |
| `route-family-split` | warn | §10.8 |
| `guard-order`, `guard-meta-unknown`, `guard-output-overlap` | error | §10.5 |
| `guard-requested-directly` | warn | §10.5 |
| `idempotent-method`, `idempotent-scope` | error | §10.6 |
| `every-format`, `every-input`, `retry-ladder` | error | §4.2 |
| `request-crosses-process` | error | §8.5 |
| `event-crosses-process` | warn | §8.5 |
| `process-invalid` | error | a process entry that matches no piece |
| `table-foreign-write` | warn | "pieces/<id> writes `t`, created by <schema>; move the write to its owner or make it a job that owner handles" |
| `piece-too-long`, `too-many-handlers`, `context-too-long` | warn | "<id> has N source lines (cap 1500)"; handlers plus routes over 20; `context.md` over 120 lines |
| `yaml-parse` | error | `murmur.yaml` does not parse |
| `oxlintrc-extends` | error | "extends X does not resolve to a file" |
| `tsconfig-include` | error | the app tsconfig misses a source folder |
| catalog warnings | warn | `subscribed-never-emitted`, `emitted-never-subscribed`, `requested-never-handled`, `orphan-contract`, `missing-tests` |

### 13.8 `test`

`murmur test [piece|glob…] [--watch] [--name <pattern>] [--coverage] [--json]` runs `node --test` in the app root
under the loader. No target: `pieces/**/*.test.ts`, `contracts/**/*.test.ts`, `capabilities/**/*.test.ts`,
`lib/**/*.test.ts`. A piece id runs its tests; a group id its `scenario.test.ts` and every descendant's tests. JSON
`{ kind: 'test', passed, failed, skipped, durationMs, failures }`; `--coverage` measures `pieces/**` minus tests.
Signals are forwarded to the child processes.

### 13.9 Docs shipping

The seven `docs/*.md` pages ship inside `@murmur/cli` (`node_modules/@murmur/cli/docs/`, synced by `prepack`); briefs
and check help link them by a path relative to the app root; inside the monorepo the repo `docs/` is used.

## 14. Dev protocol and web UI

### 14.1 Dev protocol (`@murmur/dev-protocol`; `docs/dev-protocol.md` is the user page)

`murmur dev` serves plain HTTP + JSON plus one SSE stream; the CLI live commands and the UI are its only clients.

- Base `http://127.0.0.1:4242`; `.murmur/dev.json` `{ pid, port, host, root, startedAt, protocol: 1 }` while running.
  JSON responses with `Cache-Control: no-store`; errors `{ error: { message, … } }`.
- Guard: the `Host` must be the bound host or loopback; `Origin` absent, `http://localhost:5173` (Vite dev UI) or
  `http://<Host>`; every `POST` needs `content-type: application/json`; otherwise 403.
- Endpoints: `GET /api/health`, `/api/snapshot`, `/api/events` (SSE; `since`, `piece`, `contract`, `trace`,
  `kinds`), `/api/envelopes`, `/api/traces/:traceId` (unique prefix; 409 with candidates when ambiguous),
  `/api/tree`, `/api/pieces`, `/api/pieces/:id`, `/api/pieces/:id/context?budget=`, `/api/catalog`,
  `/api/contracts/:name/schema`, `/api/logs`; `POST /api/emit { contract, payload, mode: 'emit' | 'request',
  timeoutMs? }` (400/404/502/504/503), `/api/restart`, `/api/pause`, `/api/resume` (memory transport only, else 409).
- Frames: `hello { protocol, snapshot, replayFrom }`, `env { envelope, meta: { piece?, attempt?, durationMs?,
  failed?, internal } }`, `dev.restart { reason }`, `dev.boot { snapshot, durationMs }`, `dev.boot_failed { report }`,
  `dev.child_exit { code, signal, drained }`, `dev.paused`, `dev.resumed`, `ping` (every 15 s). One SSE message per
  frame (`id: <seq>`); `since` is a seq or an age, `Last-Event-ID` works like a numeric `since`.
- Shapes: `Snapshot { app, pieces, contracts, capabilities, routes?, warnings, lastSeq }`; `Catalog { contracts,
  pieces, tree, capabilities, routes?, warnings }`; `PieceView { name, className, kind: 'domain' | 'edge' | 'mixed',
  title, summary, dir, parent, depth, children, needs, emits, handles, serves?, requests?, config, policy, status,
  counters, lastDeliveryAt, p50Ms, p95Ms, hasContextMd, hasTests }`; `ContractView { name, kind, className, hasReply,
  visibility, scope, file, emitters, requesters?, handlers, schema }`; `CatalogRoute { transport, token, key, piece,
  method?, contract?, status?, guards }`; `CatalogWarning { code, subject, pieces, message }`; `Trace { traceId,
  root, nodes, startedAt, endedAt, durationMs, failed, maxHop, background? }`; `TraceNode { id, parentId, depth,
  envelope, deliveries: [{ piece, attempt, receivedAt, endedAt, durationMs, outcome, error?, reason? }], reply?: {
  envelopeId, durationMs, timedOut, rejected? }, deduped?: { count, by } }`. Config keys carry their source, never
  values.
- Buffers: a replay ring of `--replay` (5000) `StoredEnvelope { seq, envelope, meta }`, `seq` monotonic for the dev
  session across restarts; `--payload-cap` truncates, `--redact` replaces payloads with `{ $redacted: true, bytes }`;
  each trace is written to `.murmur/traces/<traceId>.ndjson` 2 s after it goes quiet (500 files max). The app child is
  restarted with `graceMs 2000`, `forceMs 500`.
- The supervisor sees every publish through `withTap` (lossless, internal events included), not through observers.

### 14.2 Web UI (`@murmur/ui`)

- Live view over snapshot + SSE, no polling; keyboard-first (command palette `⌘K`, shortcut sheet `?`); every list
  searchable; every empty state names the next command; hash routes are the state; light/dark follow the system.
- Layout: top bar (screens, live status, pause, theme), left rail = the folder tree under `pieces/` (selecting a group
  scopes the screens), breadcrumb, main screen, one right drawer (piece, event or contract card), bottom strip (boot
  errors, missed-events notice, warning count).
- Screens: **Flock** (`#/`): live graph, groups collapsed to one node, edges per (emitter, contract, handler), guard
  edges dashed, deliveries animated, failures red, deterministic layered layout; **Events**: virtualised table with a
  filter mini-language (`piece:` `contract:` `failed:` `trace:` `internal:` `since:`); **Traces**: recent traces and a
  waterfall (indent by causation, retries stacked, request/reply brackets, `rejected 401`, dedupe and background
  notes); **Piece** (`#/pieces/<id>`): overview, contracts with JSON Schema, serves, deliveries, logs, files, context
  (the ctx brief with a token meter per section and the caps marked); **Group**: its `context.md`, children table,
  internal contracts; **Catalog**: contracts, pieces, routes, capabilities, warnings, mermaid export.
- Plain SVG for graph and waterfall, `markdown-it` for `context.md`, React; built to `dist/` with Vite (`base: './'`),
  served by `murmur dev` unless `--no-ui`.

## 15. Lint, format, typecheck

### 15.1 `@murmur/lint`

`preset.json` (apps extend it by path: `"extends": ["./node_modules/@murmur/lint/preset.json"]`): oxlint plugins
typescript, unicorn, oxc, import, promise, node; categories correctness error, suspicious and perf warn; the JS plugin
`@murmur/lint` with the rules below; plus `curly: all`, `no-unused-expressions` (no short-circuit, no ternary
statements), `import/no-cycle`, `typescript/consistent-type-imports`, `no-explicit-any`, `no-non-null-assertion`,
`explicit-module-boundary-types`, `no-restricted-imports` of `process` ("config lane only"). `type-aware.json`:
`typescript/switch-exhaustiveness-check` with `considerDefaultExhaustiveForUnions`. `oxfmt.json`: `semi`,
`singleQuote`, `printWidth 110`, `trailingComma all`, `arrowParens always`, `sortImports`.

| Rule | Says |
| --- | --- |
| `folder-local-imports` | no imports from another piece folder; ancestor `contracts.ts` is fine |
| `declared-deps-only` | framework, `node:*`, `#contracts/*`, `#capabilities/*`, `#lib/*`, the app's deps |
| `no-cross-piece-contracts-import` | a group's `contracts.ts` only from inside that group |
| `internal-contracts-scope` | internal contracts stay in their subtree |
| `piece-exports-one-class`, `one-piece-per-folder` | one class extending `Piece(` per `piece.ts`; one per folder |
| `group-folder-files` | group folders hold only `context.md`, `contracts.ts`, `scenario.test.ts` |
| `decorators-in-pieces-only`, `decorator-args-static` | ports on the piece class; decorator args are imports and literals |
| `contract-factory-wrapped` | contract factories only in `class … extends` clauses |
| `contracts-json-faithful` | no coercion, dates, transforms or non-JSON types in contracts |
| `emit-declared` | `this.emit(X)` only for `X` in `emits` |
| `no-typeof-types` | name the class; the one `typeof` is in `capabilities/web/capability.ts` |
| `erasable-syntax-only` | no `enum`, `namespace`, parameter properties; decorators only in piece files |
| `lib-pure` | §11 |
| `no-process-env` | config through the config lane |
| `no-comments-in-functions` | knowledge in names and `context.md` (tests exempt) |
| `no-nested-ternary` | no nested conditional expressions |
| `blank-line-around-blocks` | blank lines around blocks and before `return`; the attach rule; await paragraphs |
| `method-return-type` | every class method, private included, declares its return type |
| `model-no-runtime`, `tooling-no-runtime`, `core-no-node` | framework layering (§2.2) |

### 15.2 Style rules (lint-enforced, framework and apps)

Every `if`/`else`/`for`/`while`/`do` body is a block; every statement ends with `;`; a blank line before and after
every block unless first or last in its parent; a blank line between a run of two or more declarations and the block
or `return` after it; a single one-line declaration directly before the block that reads it stays attached; a
multi-line `await` statement is its own paragraph, a run of one-line awaits has no blank lines; a blank line before
`return` unless it is the only statement; no `cond && doIt()`, no statement ternaries, no nested ternaries; explicit
return types on exported functions and every class method; no `any`, no `!`; exhaustive `switch` over unions; no
comments in function bodies. Lint messages are hard rules: fix the code, never disable the rule.

### 15.3 Typecheck

`typescript@7.0.2` (`tsc`), `noEmit`, per package `tsc -p`, no project references. `@murmur/node/tsconfig.app.json`:
`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `noUnusedLocals/Parameters`, `noPropertyAccessFromIndexSignature`,
`allowUnreachableCode: false`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `isolatedModules`,
`allowImportingTsExtensions`, `module`/`moduleResolution` `nodenext`, `noEmit`; decorators are standard (no
`experimentalDecorators`). Framework source is erasable TS with no decorators; app pieces (and their tests and
fixtures) may use standard decorators and `using`; contracts, `capabilities/**` and `murmur.config.ts` stay erasable.

## 16. Pieces as modules: folder, context.md, storage, sizing

### 16.1 Folder

```
pieces/todos/
  piece.ts            export class Todos extends Piece({ … }) — ports only, logic in private files
  context.md          frontmatter + What / Why / Handles-Emits-Requests / Needs / Invariants / Gotchas / Out of scope
  piece.test.ts       testPiece tests; one per handler, one failure, one redelivery
  schema.sql          DDL of the tables this piece writes
  repository.ts …     private files, imported only from this folder
  fixtures/*.json     payloads for tests and `murmur emit --fixture`
```

A group folder holds only `context.md`, `contracts.ts` and `scenario.test.ts`; its `context.md` is inherited by
every piece below it in `ctx`.

### 16.2 `context.md`

```markdown
---
title: Todos
summary: The one writer of the todos table — creates, reads, completes and removes todos, announcing each change.
---

# todos

## What
## Why
## Handles / Emits / Requests
Handles: todos.CreateTodo, todos.GetTodo
Emits: todos.TodoCreated
Requests: none
## Needs
Needs: sqlite
Storage: `todos`, `todo_requests` (`./schema.sql`)
## Invariants
## Gotchas
## Out of scope
```

- `title` and `summary` feed the catalog, the tree, the UI and parents' briefs; a missing `summary` is a warning, a
  missing `context.md` a boot error. Edge pieces add `Serves: GET /todos, POST /todos`.
- Domain words, not code. Invariants carry the idempotency story; Gotchas what a regenerating agent would get wrong.
- **Lane lines**: one parser reads, outside code fences, a line `Handles: <items>` (also `Listens`, `Emits`,
  `Requests`, `Serves`, `Needs`; `- Needs:` and `- **Needs:**` work) or a `## Needs` section whose non-blank lines
  are items. Items are comma-separated; `(…)` remarks and backticks are dropped and the first word is the name (a
  serves item keeps verb and path); `none` or `—` declares a lane empty. Inside a Needs remark, a clause starting
  with `table(s)` / `owns` / `reads` / `writes` names tables whose DDL `ctx` inlines.

### 16.3 Storage

The DDL of the tables a piece writes lives in `pieces/<id>/schema.sql`, applied once by the default migration list;
tests read the same file (`fakeSqlite({ schema: 'own' | 'app' })`); `ctx` inlines it under `## Storage`. One writer
per table (`table-foreign-write` warns otherwise: ask the owner with a command or a job); a reader declares the table
in `context.md` (`Needs: sqlite (reads todos)`). Read models with `db.row`/`db.rows`.

### 16.4 Sizing and cohesion

<!-- verbatim from the murmur-piece skill and docs/piece-authoring.md -->
The unit is one responsibility, one owner of state, a handful of handlers — not one function: a store piece with
get/create/update/delete/list is one piece; a saga with five handlers is one piece. In order:

1. describable in one sentence without "and";
2. one writer of each table; readers declare the table in context.md;
3. things that change together live together;
4. handlers sharing no state or helpers are a split smell;
5. start coarse, split on pain, never speculatively.

Caps (`limits` in `murmur.config.ts`): assembled ctx large 25k / warn 40k / fail 80k tokens, ~1,500 source lines
(excluding tests, fixtures and nested pieces), ~20 handlers (handlers plus routes), `context.md` ~120 lines. There is
no lower bound in any tool: one tiny stateless handler is legal and only ever gets a *merge candidate* note from
`piece-reviewer`. `murmur ctx` prints the tier `ok | large | warn | fail` of the full brief (exit 1 only at fail);
`murmur check` warns `piece-too-long`, `too-many-handlers`, `context-too-long` with help "split by the five heuristics
in <path to piece-authoring.md>". The example's `todos` (five handlers over one table) and `api/rest` (six routes) are
the reference sizes.

## 17. Claude Code plugin (`plugins/murmur`)

- Agents: `piece-writer` (writes or regenerates exactly one piece from its `murmur ctx` brief; context.md +
  contracts + tests are the spec, code is disposable; reads only the folder files its task touches; finishes with
  `murmur check --fix`, `murmur check`, `murmur test` green) and `piece-reviewer` (read-only review of one piece
  against its invariants, contracts and style rules; starts from `murmur ctx pieces/<id> --with code,tests`; returns
  mergeable or needs-changes with `file:line — issue — fix`; flags merge candidates).
- Skills: `/murmur-piece <id> [from scratch]` (orchestrates one piece end to end through the CLI, spawning
  `piece-writer`), `/murmur-contract <ClassName>` (adds or changes a contract class, at most four questions, via
  `murmur new contract`), `/murmur-review [path | --changed]` (`murmur check --types --json`, one `piece-reviewer` per
  changed piece, a verdict). Repo knowledge comes only from the murmur CLI, never from grepping the repo. The
  murmur-piece skill carries the sizing block of §16.4 verbatim (a test compares it with `docs/piece-authoring.md`).
- Hooks: `SessionStart` prints murmur usage lines; `PostToolUse` on `Edit|Write` runs `murmur check` on the touched
  piece folder (every piece for `contracts/` or `capabilities/` changes) and on `Bash` when the command changed files
  under `pieces/`, `contracts/` or `capabilities/` (300 ms debounce, stamp cache under `.murmur/cache/hook/`); `Stop`
  runs one `murmur check` of the app.

## 18. Reference app (`examples/todo-api`)

A small REST todo service on one bus with an SSE feed beside it; `docs/api-preview.md` shows its files byte for byte
(a test compares them).

| Piece | Kind | Does |
| --- | --- | --- |
| `auth` | domain | answers the `Authenticate` (bearer token from config) and `RateLimit` (`optional: [Authenticate]`, `kv.incr` one-minute window keyed by user or IP, 429 with `retry-after`) guards |
| `todos` | domain | the one writer of `todos`: `CreateTodo`, `GetTodo`, `ListTodos` (`Paging`/`Page`, cursor), `SearchTodos`, `CompleteTodo`, `RemoveTodo`; emits `TodoCreated/Completed/Removed`; enqueues a `NotifyTodo` job (`dedupeKey`) in the write transaction |
| `stats` | domain | read model counting todos from todo events; answers `GetStats` |
| `notifier` | domain | runs `NotifyTodo` jobs and `SweepNotifications` (`every: '1m'`), keeps a day of sent notifications |
| `api/rest` | edge | REST over todos and stats: shorthands and methods, status codes, ETag/304, 404, 204, `POST /todos` idempotent by `auth.userId` |
| `api/feed` | edge | SSE stream of todo events on `GET /events/todos` |

- `murmur.config.ts`: `defineApp({ name: 'todo-api', transport: () => createMemoryTransport(), capabilities:
  [sqlite], processes: { api: { pieces: ['api/**', 'auth', 'todos', 'stats'], jobs: false }, worker: { pieces:
  ['notifier'] } } })`.
- `murmur.yaml`: `pieces.auth.tokens` / `perMinute`, `capabilities.sqlite.path: '${DATABASE_PATH:-./todo.db}'`,
  `capabilities.web.port: ${PORT:-3000}`.
- `capabilities/web/capability.ts`: `http({ guards: [Authenticate, RateLimit], log: (auth) => ({ user: auth.userId ??
  null }) })` and `WebRequest`. `lib/etag.ts` is the lib-lane example.
- Contracts: `contracts/auth.ts` (`Principal`, `Quota`, the two guards), `contracts/todos.ts`, `contracts/stats.ts`,
  `contracts/notifications.ts` (`NotifyTodo`, `SweepNotifications`, commands with output `{}`).
- Tests: every piece has `piece.test.ts`; `e2e.test.ts` drives the whole app through `createTestApp`;
  `tooling.test.ts` runs `murmur dev` + `murmur trace`, `murmur start api` + `murmur start worker` on one database
  file (the job crosses processes), and catalog, check, ctx, coverage, lint and typecheck. CI runs the example's `check` and
  `murmur catalog --strict`.
