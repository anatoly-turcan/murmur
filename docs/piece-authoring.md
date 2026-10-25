# Piece authoring

A piece is one folder under `pieces/` with a `piece.ts`, a `context.md` and tests. Its id is the folder path
(`pieces/api/rest/` → `api/rest`). It talks to other pieces only through contracts on the bus.

- `piece.ts` exports exactly one class, `export class Todos extends Piece({ needs, config, emits }) { … }`; decorated
  methods are its ports (`@Handle(Contract)`, `@Serve(binding)`). Everything else in the folder is private code.
- `context.md` + the contracts + the tests are the spec; code is disposable. `murmur ctx <id>` assembles the brief and
  lists the folder's files; read only the ones the task touches.
- A refusal is a returned `reject(status, message)` (guards, `rejectable(...)` outputs), not found `null`, failures
  throw. Handlers are idempotent under redelivery.
- Edge pieces (HTTP and other transports): [ingress.md](ingress.md); handles: [capability-authoring.md](capability-authoring.md).
  The full example: `docs/api-preview.md` and `examples/todo-api`.

## The class

```ts
import { sqlite } from '@murmur/node/capabilities';
import { Handle, Piece, type Delivery } from 'murmur';

import { CreateTodo, type Todo, TodoCreated } from '#contracts/todos';

import { TodoRepository } from './repository.ts';

export class Todos extends Piece({ needs: { db: sqlite }, emits: [TodoCreated] }) {
  private readonly todos = new TodoRepository(this.db);

  @Handle(CreateTodo)
  async create(input: CreateTodo, delivery: Delivery): Promise<Todo> {
    const fresh = { id: this.ids.uuid(), title: input.title, createdAt: this.clock.now().toString() };
    const claim = await this.todos.claim(delivery.envelope.id, fresh);

    if (!claim.announced) {
      await this.emit(TodoCreated, { id: claim.todo.id, title: claim.todo.title });
      await this.todos.markAnnounced(delivery.envelope.id);
    }

    return claim.todo;
  }
}
```

| `Piece({ … })` | Puts on `this`                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `needs`        | `{ field: token }`: `needs: { db: sqlite }` gives `this.db: Sqlite`, started before construction          |
| `config`       | `{ key: zodSchema }`: `this.config.key`, validated and frozen (see Config)                                |
| `emits`        | the only events `this.emit` accepts (compile error, lint `emit-declared`, runtime `EmitNotDeclaredError`) |
| `policy`       | `{ concurrency?, timeoutMs?, retry? }` (8, 30000, 5 attempts); yaml `pieces.<id>.$policy` overrides it    |

Always there: `this.log`, `this.clock`, `this.ids`, `this.config`, `this.emit(Event, payload)`,
`this.request(QueryOrCommand, input, { timeoutMs?, signal? })`. `this.request` takes any query, command or guard; the
call sites are its declaration (the catalog reads them from source). `Piece()` with nothing to declare is fine.

- No constructor, no `super()`. Field initialisers run after the capabilities started, so `new TodoRepository(this.db)`
  works; a throwing one is `BootError { phase: 'construct' }`. `new Todos()` outside the runtime throws (`testPiece`).
- Optional `onStart()` / `onStop()` methods run once per process (after every piece subscribed / after the last
  delivery settled) inside a run, so `this.emit` and `this.request` work there.
- A contract twice in `emits`, a request in `emits`, two `@Handle` for one contract or a non-token `needs` value
  throws `PieceDefinitionError` at import.

## `@Handle` and the delivery

`@Handle(CreateTodo)` means "the bus delivers `todos.CreateTodo` here". The parameter _is_ the contract (an instance,
already validated); the return _is_ the output, checked by tsc (wrong, missing or extra key, `undefined` for a
nullable are compile errors on the decorator line). Annotate the return for the reader. An event handler returns
nothing. One handler per contract per piece; the method name is free (`#private` works).

The optional second parameter `delivery: Delivery` is `{ envelope, attempt, signal, piece }`: the
[envelope](envelope.md) (its `id` is the idempotency key), the 1-based attempt, a signal that aborts on handler timeout
or shutdown, the piece id. Decorator arguments are static: an imported class, a literal path
(`decorator-args-static`).

## Contracts

```ts
export class Todo extends Model({ id: z.string(), title: z.string(), done: z.boolean() }) {}
export class CreateTodo extends Command({ title: z.string().min(1).max(200) }, Todo) {}
export class GetTodo extends Query({ id: z.string() }, Todo.nullable()) {}
export class RenameTodo extends Command({ id: z.string(), title: z.string() }, rejectable(Todo)) {}
export class TodoCreated extends Event({ id: z.string(), title: z.string() }) {}
export class ListTodos extends Query({ done: z.boolean().optional(), ...Paging() }, rejectable(Page(Todo))) {}
```

- Kinds: `Query` (no side effects, answered once per trace), `Command` (effects, never deduplicated), `Event` (fire and
  forget, any number of handlers), `Guard` (see [ingress.md](ingress.md)), `Model` (a shape). The class is the value
  you pass, the input type and the schema owner (`CreateTodo.input`, `CreateTodo.output`, `CreateTodo.jsonSchema()`).
- The wire name is `<file domain>.<ClassName>`: `contracts/todos.ts` → `todos.CreateTodo`; `{ name }` overrides it.
- Public contracts live in `contracts/<domain>.ts` and are imported as `#contracts/<domain>`; a group folder's
  `contracts.ts` holds contracts internal to that folder (`internal-contracts-scope`). Shared pure code is
  `lib/<module>.ts`, imported as `#lib/<module>`: no I/O, no state (`lib-pure`); see `murmur ctx lib/<module>`.
- Every "not found" is `Todo.nullable()`, so edges map `null` → 404 uniformly. Outputs are plain objects (never
  `new Todo(...)`). Schemas survive a JSON round trip: no `z.coerce.*`, dates, transforms (`contracts-json-faithful`).
- Lists: `...Paging({ max })` adds `limit`, `cursor`; `Page(Model)` = `{ data, next_cursor }`. `@murmur/node/lib`
  `cursor.encode(binding, position)` / `cursor.decode(binding, raw, PositionSchema)`: a bad cursor is a 400.

## Outputs, errors, retries

- A query or command handler returns the output, validated (`ContractViolationError`, side `reply`) and sent as the
  reply; same shape on every path. With `rejectable(Todo)` it may `return reject(409, message, { code })`: a successful
  delivery (no retry, no dead letter, a Query returning one still answered once per trace), rendered by the edge.
- Throw to fail; never swallow. Any error retries with backoff unless it carries `retryable: false`
  (`NonRetryableError`). A delivery that carries a reply address is never attempted again once the requester's
  deadline passed: it dead-letters with `reason: 'requester-gone'`. The final failure is in `murmur tail --failed`;
  the requester gets `RemoteError { cause }` or `RequestTimeoutError`. Invalid inputs never reach the handler.
- Durable, delayed or periodic work is a job, never a timer: `this.jobs.enqueue(C, input, options)`, `{ every: '1m' }`.

## Idempotency

Every delivery can arrive twice. Make the second run a no-op, keyed on `delivery.envelope.id`:

- a side table (`todo_requests(envelope_id PK, todo_id, announced)`, `INSERT OR IGNORE` in one transaction with the
  insert) when the reply must carry the same id on redelivery;
- `INSERT OR IGNORE` / `UPDATE … WHERE done = 0` when the write itself is naturally idempotent;
- `needs: { kv }` and `await this.kv.once(delivery.envelope.id, async () => { … })`: the marker and every sqlite call
  inside commit together (as in `this.db.transaction(async (tx) => …)`, which a nested call joins).

Effects outside sqlite (`fetch`, `emit`) stay at-least-once; consumers dedupe on their own ids. Write the invariant in
`context.md` and prove it with a test that delivers the same `envelopeId` twice.

## State on `this` and callbacks that lose context

One instance per process: fields live as long as the process (a cache, an SSE client set, a rate window). Never keep
per-delivery facts there; take them from `delivery` or `req`.

`this.emit`, `this.request`, `this.log` and ALS-aware handles (`this.db`, `fetch`) find the current delivery through
`AsyncLocalStorage`. Inside a handler, an `@Serve` method, `onStart`/`onStop` and anything they `await`, they join that
run. These callbacks do not carry it: an `EventEmitter` listener, an abort listener, a timer or `fs.watch` created
outside a run, `ReadableStream` `cancel`/`pull` called by the consumer, a socket `data` handler. An emit or request
from there opens a **background run** for the piece (fresh trace, labelled `background` in `murmur trace`,
`$sys.emit.background`); nothing throws. A sqlite call there takes the lock on its own. Prefer doing the work in the
handler and keeping callbacks to bookkeeping (`clients.delete(controller)`).

## Config and storage

`config: { perMinute: z.number().int().positive().default(60) }` gives `this.config.perMinute`. Sources, highest first: env `MURMUR__<PIECE>__<KEY>` (`MURMUR__AUTH__PER_MINUTE=100`), env `MURMUR__<KEY>`, yaml
`pieces.<id>.<key>`, yaml `shared.<key>`, the schema default. Values are read as strings, validated raw first and then
as JSON. `murmur ctx` lists each key's env var and yaml path, never its value. Never read `process.env`.

The DDL of the tables a piece writes lives in `pieces/<id>/schema.sql`, applied once by the default `migrations` list;
tests read the same file, `murmur ctx` inlines it under `## Storage`. One writer per table (`table-foreign-write` warns
otherwise: ask the owner with a command or a job); a reader declares it in `context.md` (`Needs: sqlite (reads todos)`).
Read models with `await this.db.row(Todo, sql, id)` / `db.rows(…)`: INTEGER 0/1 → boolean, JSON TEXT → array/object.

## `context.md`

```markdown
---
title: Todos
summary: Owns the todos table — creates, reads, completes and removes todos, announcing each change.
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

- Frontmatter `title` and `summary` feed the catalog, the tree, the UI and parents' briefs; a missing `summary` is a
  warning, a missing `context.md` a boot error. Edge pieces add `Serves: GET /todos, POST /todos`.
- Write domain words, not code. Invariants carry the idempotency story; Gotchas what a regenerating agent would get
  wrong. Group folders have their own `context.md`, inherited by every piece below in `ctx`; they hold only
  `context.md`, `contracts.ts` and `scenario.test.ts`.

### Lane lines

One parser reads the lanes outside code fences: a line `Handles: <items>` (also `Listens` for events, `Emits`,
`Requests`, `Serves`, `Needs`; `- Needs:` and `- **Needs:**` work) or a `## Needs` section whose non-blank lines are
items. Items are comma-separated; `(…)` remarks and backticks are dropped and the first word is the name (a serves
item keeps its verb and path). `none` or `—` declares a lane empty. Inside a Needs remark, a clause starting with
`table(s)` / `owns` / `reads` / `writes` names tables whose DDL `murmur ctx` inlines.

A folder with `context.md` or tests but no `piece.ts` and no child folders is a **leaf under regeneration**: `murmur
ctx` renders it like `--withhold-code` and takes each lane from the catalog snapshot (`.murmur/catalog-snapshot.json`,
written by every `murmur catalog` and `murmur dev` analysis), these lines, then the tests (`t.deliver` → handles,
`t.emitted` → emits, `t.respond` → requests, `t.fetch` → serves, `needs: { … }` → needs). The header names each source.

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

`murmur ctx <id>` prints the tier `ok | large | warn | fail` of the full brief, code and tests included (exit 1 only
at fail); `murmur check` warns `piece-too-long`, `too-many-handlers` (handlers plus routes) and `context-too-long`. The example's `todos` (5 handlers
over one table) and `api/rest` (6 routes) are the sizing guidance.

## Testing with `testPiece` and `createTestApp`

```ts
test('create stores the todo, replies with it and emits TodoCreated', async () => {
  await using t = await testPiece(Todos);
  const todo = await t.deliverJson(CreateTodo, createTodo);
  assert.deepEqual(t.emitted(TodoCreated), [{ id: todo.id, title: 'buy milk' }]);
});
```

- `await testPiece(Class, { needs?, config?, auth?, now?, id? })` (from `@murmur/node/testing`) constructs the piece
  like the runtime and fakes every need left out of `needs` (a passed one wins; a capability without `fake` must be
  passed): `sqlite` → `fakeSqlite({ schema: 'app' })` (`'own'`: this folder's `schema.sql`; or a file list),
  `jobs` → rows on that sqlite (joins the delivery's transaction; `t.enqueued(C)` → `[{ input, options }]`;
  `await t.runJobs()` runs the due ones this piece handles), `kv`, `fetch` (refuses until you pass `fakeFetch(fn)`).
  `t.needs.<field>` is the handle; `t.log`, `t.ids` (`issued`), `t.clock` (frozen at `now`; `await t.clock.advance(ms)`).
- `t.deliver(C, input, { attempt?, traceId?, envelopeId? })` runs in a real async context (the fake sqlite joins its
  transaction); `t.deliverJson` takes fixtures as-is; the same `envelopeId` twice is a redelivery. `t.emitted(C?)`,
  `t.respond(C, fn)` answers `this.request(C)`, `t.requested(C)`, `t.fetch(request, { auth })` drives an edge method
  without its guards ([ingress.md](ingress.md)), `await t.reset()` (forgets emits, requests, log, jobs); `await using`.
- Admission and flows across pieces: `await using app = await createTestApp({ env? })` boots the whole app (found
  from the test file) on a temp migrated sqlite file, guards included: `app.fetch('/todos', init)`, `app.db`,
  `await app.clock.freeze(instant)`, `await app.jobs.drain()` (polling is off), `await app.reset()` (app rows, jobs,
  idempotency rows, kv counters and once markers, clock override; `murmur_*` tables stay).
- One test per handler, one failure path, one redelivery; `fixtures/*.json` double as `murmur emit --fixture`.

## Boundaries and style (lint, `murmur check`)

| Rule                                                                                            | Says                                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folder-local-imports`                                                                          | no imports from another piece folder; ancestor `contracts.ts` is fine                                                                              |
| `declared-deps-only`                                                                            | framework, `node:*`, `#contracts/*`, `#capabilities/*`, `#lib/*`, the app's `package.json` deps                                                    |
| `lib-pure`                                                                                      | `lib/**` imports `node:*` without I/O, `zod`, `murmur`, `@murmur/node/lib`, `#contracts/*`, `#lib/*`; no top-level `let`; I/O goes to a capability |
| `piece-exports-one-class` / `one-piece-per-folder`                                              | `piece.ts` exports one class extending `Piece(`; one per folder                                                                                    |
| `decorators-in-pieces-only` / `decorator-args-static`                                           | ports live on the piece class; decorator arguments are imports and literals                                                                        |
| `emit-declared` / `no-typeof-types`                                                             | `this.emit(X)` only for `X` in `emits`; name the class, the one `typeof` of an app is in `capabilities/web/capability.ts`                          |
| `erasable-syntax-only`                                                                          | no `enum`, `namespace`, parameter properties; decorators only in piece files                                                                       |
| `curly`, `blank-line-around-blocks`, `no-nested-ternary`, `no-unused-expressions`               | blocks always, blank lines around blocks and before `return`, attach rule, await groups, no nested or statement ternaries, no `cond && doIt()`     |
| `no-explicit-any`, `no-non-null-assertion`, `switch-exhaustiveness-check`, `method-return-type` | no `any`, no `!`, a `switch` over a union covers every member (type-aware), return types on exported functions and methods                         |
| `no-comments-in-functions`, `no-process-env`                                                    | knowledge in names and `context.md`; config through the config lane                                                                                |

`murmur check` adds structure findings and route findings (see [cli.md](cli.md)). Lint messages are the hard rules:
fix the code, never disable the rule.
