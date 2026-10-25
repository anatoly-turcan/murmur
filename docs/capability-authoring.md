# Capability authoring

A capability is the only way a piece touches the outside world: a database, an HTTP client, a mailer, an inbound
server. One instance per process, started before the pieces are constructed. A capability is I/O or state, never a
helper bag: shared pure code (formatting, codecs, row types) lives in `lib/<module>.ts`, imported as `#lib/<module>`.

- `defineCapability({ name, config?, needs?, start, stop?, docs?, ingress?, requests?, emits? })` from `murmur`
  returns a **token**: the definition the app runs and the value a piece puts in `needs`. The handle type is inferred
  from `start`; nothing generates a `.d.ts`.
- A piece declares `Piece({ needs: { mail: mailer } })` and gets `this.mail` typed as the handle.
- Handles are resolved **once**, at construction. A handle that needs per-delivery facts (abort signal, trace,
  transaction) reads them from the run context with `current()` from `@murmur/node`: the handle is **ALS-aware**.
- App-local capabilities live in `capabilities/<name>/capability.ts` (default export), are discovered automatically
  and are imported by pieces as `#capabilities/<name>`. Built-ins come from `@murmur/node/capabilities`.
- **Every docs page shows one example of what the handle returns**, e.g. sqlite rows are plain objects with integer
  booleans: `{ id: 't1', title: 'buy milk', done: 0 }`.

## Definition

```ts
import { current } from '@murmur/node';
import { defineCapability } from 'murmur';
import { z } from 'zod';

export interface Mailer {
  send(to: string, subject: string): Promise<{ messageId: string }>;
}

export default defineCapability({
  name: 'mailer',
  config: z.object({ url: z.string(), timeoutMs: z.number().default(5000) }),
  docs: MAILER_DOCS,
  start: ({ config }): Mailer => ({
    send: async (to, subject) => {
      const signal = current()?.signal ?? null;

      const response = await fetch(config.url, {
        method: 'POST',
        body: JSON.stringify({ to, subject }),
        signal,
      });

      return (await response.json()) as { messageId: string };
    },
  }),
});
```

```ts
import mailer from '#capabilities/mailer';

export class Welcome extends Piece({ needs: { mail: mailer } }) {
  @Handle(UserSignedUp)
  async welcome(event: UserSignedUp): Promise<void> {
    await this.mail.send(event.email, 'welcome');
  }
}
```

| Field                  | Meaning                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `name`                 | unique per app; config lives under `capabilities.<name>` (yaml) and `MURMUR__CAP_<NAME>__<KEY>` (env)       |
| `config`               | a zod object; values coerced like piece config                                                              |
| `needs`                | names of capabilities this one starts after; their started handles arrive in `start({ needs })`             |
| `start(ctx)`           | returns the handle (sync or async); 30 s timeout                                                            |
| `stop(handle, signal)` | optional; disposal is LIFO; `signal` aborts after 2 s                                                       |
| `docs`                 | markdown page pasted into every `murmur ctx` brief of a piece that needs it; else a sibling `capability.md` |
| `ingress`              | `true` for capabilities that bring work in (servers, consumers): started even if no piece needs them        |
| `requests` / `emits`   | contracts an ingress sends outside any binding; the catalog lists the emitter as `(external: <name>)`       |

`start` receives `{ config, needs, bus, log, clock, ids, mode: 'dev' | 'prod', signal, root, ingress? }`. `bus` has
`emit`, `request`, `enter` and `stopping` (aborts when shutdown starts). `root` is the absolute app root: resolve
app-relative paths against it, never against `process.cwd()`. `ingress` is the port of the next section.

## ALS-aware handles

The handle is the object `start` returned; there is no per-delivery wrapper. When a piece calls it, the current run is
in `AsyncLocalStorage`: `current()` returns `{ traceId, eventId?, hop, piece, deliveryId?, attempt?, signal,
deadline?, internal }` or `undefined` outside any run.

- `sqlite`: `current()?.deliveryId` tells which delivery holds the transaction, so a plain call, a `kv.once` and a nested
  `transaction(fn)` from the same delivery join it; outside a run each call takes the lock on its own.
- `fetch`: aborts with `current()?.signal` and adds `x-murmur-trace` + `traceparent` from `current()?.traceId`.
- `log`: stamps `piece` and `traceId` from the run.

Read the run at call time, never in `start` (no run exists then). Design for `undefined`: a call from a callback the
async context does not follow (see [piece-authoring.md](piece-authoring.md)) has no run. `testPiece` runs every
`deliver` and `fetch` inside a real run, so fakes see the same facts. Pieces always get the started handle.

## Handle docs

The ctx brief renders, per needed capability: `### <field> (<name>)`, the docs page, then the
`export interface <PascalName>` block found in the capability file (or the built-in types). When the brief must shrink
only the **first H1 section** of the page and the interface survive, so front-load it:

```markdown
# mailer

`this.mail.send(to, subject)`: one SMTP relay per process, retried by the bus, never by the handle.

- Returns `{ messageId: 'm-1f9a' }`; throws `MailerError` (retryable) on 5xx, `NonRetryableError` on a bad address.
- Idempotency: pass `delivery.envelope.id` as the `Message-ID` seed; the relay drops duplicates.
- Config: `url`, `timeoutMs` (default 5000).
```

Rules for the page: what the handle is in one line; **one concrete example of a return value** (including surprises
like integer booleans, `undefined` for "no row", bigint ids); which errors are retryable; how to stay idempotent;
config keys with defaults. No implementation notes.

## Registering

```ts
export default defineApp({
  name: 'todo-api',
  transport: () => createMemoryTransport(),
  capabilities: [sqlite],
});
```

- Built-ins `sqlite`, `kv`, `fetch` are plain tokens (`sqlite()` is a type error); list the ones the app uses in
  `capabilities`. `log`, `clock`, `ids` are always injected, never declared.
- App-local tokens in `capabilities/<name>/capability.ts` are discovered; `capability.md` beside one is its docs
  page; its tests live in `capabilities/**/*.test.ts`. The configured http token (`capabilities/web/capability.ts`)
  is one of them.
- A piece's `needs` value that was never started is a boot error naming the field (`needs.db: capability sqlite is
  not started`); capability cycles are boot errors (`capability cycle: a → b → a`).

## Lifecycle

1. Plan: the capabilities some piece needs, plus every `ingress`, plus their `needs`; anything else raises
   `capability-unused`. An ingress capability starts only when a loaded piece serves through it (or needs it) and
   its config `enabled` is not `false`; otherwise it never starts and logs `<name> not started: <reason>`. `enabled`
   is reserved for ingress capabilities: the framework reads it (`MURMUR__CAP_<NAME>__ENABLED` or yaml), the
   capability's own schema never sees it.
2. Start in dependency order, each bounded by 30 s (`$sys.capability.started { name, durationMs }`); a failure stops
   what already started and fails the boot.
3. Construct the pieces with the started handles (field initialisers may use them), then subscribe.
4. Shutdown: ingress capabilities stop first with the drain budget (the longest piece timeout, at least 2 s) in their
   `stop` signal, the bus drains, then every capability stops in reverse start order (2 s each).

## Ingress capabilities, binding makers and adapters

An ingress capability has two halves. **Binding makers** hang off its token and return a `Binding`
`{ transport, key, capability, guards? }` that pieces pass to `@Serve`; core's `Serve`, metadata, the catalog and the
conflict check key on `transport` + `key` only, so a new transport needs no core change. The **adapter** runs in
`start`: it reads the served targets from the ingress port and turns each outside event into one ingress entry.

```ts
start: ({ ingress, config }) => {
  const targets = ingress.targets('queue');

  return consume(config.url, async (message) => {
    const target = targets.find((candidate) => candidate.serve.binding.key === `topic ${message.topic}`);
    if (target?.serve.get === undefined) {
      return;
    }

    const method = target.serve.get(target.instance());
    const init = { transport: 'queue', binding: target.serve.binding.key, payload: { topic: message.topic } };

    await ingress.invoke(target.piece, init, (delivery) => method(message, delivery));
  });
};
```

- `ingress.targets(transport)` lists `{ piece, serve: { binding, get, contract }, instance() }`: `get(instance)` is
  the decorated method of a method binding; `contract` is set for a class-level shorthand (forward it with
  `bus.request(contract, input)` inside the entry).
- `ingress.invoke(piece, { transport, binding, traceId?, payload?, signal? }, fn)` runs `fn(delivery)` as a local job
  of that piece: a run context (so `this.emit`/`this.request` and ALS-aware handles work), the piece's timeout and
  abort signal, emits drained before it returns, `$sys.ingress.received/completed/failed` published. `payload` is what
  the trace root shows (`{ method, path }` for http).
- The port also carries the jobs lane (the built-in `jobs` capability uses it): `ingress.ready` resolves once the
  pieces are subscribed, `jobTargets()` lists the local command handlers with their piece timeout, `retry` and
  `every`, `invokeLocal(contract, input, { id, attempt, signal })` runs one as an entry of transport `job`, and
  `report('job.claimed' | 'job.succeeded' | 'job.failed' | 'job.dead', payload)` publishes `$sys.job.*`.
- Run the guards of the binding (one `bus.request` each, in order, each with the earlier outputs it lists as
  `prior`) inside the entry before reading the body or calling the method, and answer the first `Rejection` reply
  yourself. Validate an inbound trace id against `^[0-9a-f-]{8,64}$`.
- `@murmur/node/capabilities` `http(options)` is the reference adapter; see [ingress.md](ingress.md) for what it
  does with requests, guards and errors.

## Built-ins and what they return

| Token       | Handle                         | Example return                                                                                                                         |
| ----------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `sqlite`    | `run/get/all/exec/insert`      | `get` → `{ id: 't1', title: 'buy milk', done: 0 }` or `undefined`; `run` → `{ changes: 1, lastInsertRowid: 1 }`                        |
|             | `transaction(async (tx) => …)` | commit on return, rollback on throw; a nested call joins; `insert('todos', { id: 't1', … })` → `'t1'`                                  |
|             | multi-process safe             | file databases in WAL, `BEGIN IMMEDIATE` transactions, config `busyTimeoutMs` (5000) before `database is locked`                       |
| `kv`        | `get/set/delete/once/incr`     | `once(id, () => 'sent')` → `{ first: true, value: 'sent' }`, then `{ first: false }`; `incr(key, { windowMs })` → `{ count, resetAt }` |
| `fetch`     | platform `fetch`               | a standard `Response`; non-2xx resolves                                                                                                |
| `http(...)` | ingress, the server            | config `port` (3000), `host` (127.0.0.1), `trustProxy` (false), `enabled`; `capabilities.get('web')` → `{ url, port }`                 |

A relative sqlite `path` and every `migrations` glob resolve against the app root:

```yaml
capabilities:
  sqlite:
    path: '${DATABASE_PATH:-./todo.db}'
    migrations: pieces/**/schema.sql
```

## Testing

Pieces never see the real capability in unit tests. `defineCapability({ …, fake: ({ root, pieceDir, clock, needs }) => handle })`
gives `await testPiece(Welcome)` the handle to inject when the test leaves the need out (`needs` holds the handles of
the capability's own `needs` by name, e.g. the jobs fake writes on `needs.sqlite`); without `fake` the test passes
it: `testPiece(Welcome, { needs: { mail: fakeMailer } })`, keyed by field name and typed from the token. Built-ins ship
fakes (`sqlite` → `fakeSqlite({ schema: 'app' })`, `jobs` → rows on the faked sqlite, `kv` → `fakeKv(clock)`, `fetch` → refuses
until `fakeFetch(handler)` is passed), all exported from `@murmur/node/testing`. Test a capability by calling `start`
with a hand-built start context, or through `createTestRuntime` with a piece that needs it. `runInContext(run, fn)`
from `@murmur/node/testing` runs `fn` inside a run context (`{ traceId, piece, deliveryId, attempt, signal }`,
defaults filled, pass any of them) without a piece, so an ALS-aware handle sees a delivery: `await runInContext({ piece: 'mailer' }, () => handle.send(…))`; each call is a new delivery.
