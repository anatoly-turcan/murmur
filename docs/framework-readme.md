# murmur

> The framework README at 0.3.0, the one the pilot 2 team read (pilot 1 read the 0.2.1 version). Release snapshots
> strip the `## Repository` and `## Releasing` sections; the rest is as shipped. The repository README is now the
> research write-up.

murmur is a TypeScript application framework for apps that AI agents write and maintain. An app is a flock of small,
independent **pieces**. Pieces never call each other: they talk only through a message **bus**, using typed
**contracts** that both sides import. No piece knows the whole picture, and that is the point — every piece is sized so
that one agent, with one context window, can read everything it needs and rewrite the piece from scratch.

The framework does the bookkeeping that keeps this honest. Each piece declares what it listens to, what it emits, which
config keys it reads and which outside-world handles (database, HTTP, key-value store…) it needs; the runtime injects
exactly that and nothing more, lint rules enforce the boundaries, and the CLI derives a catalog of who emits and handles
what. `murmur ctx <piece>` assembles the brief for one piece — rules, its `context.md`, the contracts it touches, its
storage, routes and capability sheets, plus a list of the folder's files — so an agent reads one document, then opens
only the files its task touches (`--with code,tests` puts them inline).

Around that sit the tools you need to run the flock: a dev server with hot restart and a web UI (event stream, traces,
piece pages, catalog), a Claude Code plugin whose piece-writer/reviewer agents drive the same CLI, an in-memory transport for development and tests, and an AMQP (RabbitMQ) transport for
production.

## Requirements

- **Node.js 26** or later. murmur runs TypeScript natively (type stripping): no build step, no `tsc` emit.
- **pnpm** (12.x is what murmur is developed with). Generated apps and all examples assume pnpm.
- The packages are distributed through a **private npm-compatible registry** (for example verdaccio), not the public
  npm registry. Whoever gave you this release tells you its URL; below it is `$NPM_REGISTRY`. The registry must also
  proxy the public npm registry (zod, oxlint, typescript… come from there).

## Install

Point pnpm at the registry once (user level), then scaffold an app:

```sh
pnpm config set registry "$NPM_REGISTRY"
pnpm dlx --allow-build=@swc/core @murmur/cli new app my-app
cd my-app
pnpm install
```

If you prefer not to change your user config, pass the registry to the scaffold instead; it writes `my-app/.npmrc`:

```sh
pnpm --registry "$NPM_REGISTRY" dlx --allow-build=@swc/core @murmur/cli new app my-app --registry "$NPM_REGISTRY"
```

A project `.npmrc` in the folder you scaffold from is not read inside `my-app` (pnpm looks only in the project and your
user config), so with that setup use the `--registry` form above.

`--allow-build=@swc/core` lets pnpm 12 run the build script of the TypeScript transformer behind the app loader
(without it `dlx` warns about ignored builds). The new app pins every murmur package to the CLI's own version and
contains `package.json`, `pnpm-workspace.yaml` (`allowBuilds` for `@swc/core`, which pnpm 12 otherwise refuses), `tsconfig.json`,
`murmur.config.ts`, `murmur.yaml`, `.oxlintrc.json`, `.oxfmtrc.json`, `AGENTS.md`,
`README.md` (with a `Registry` section when `--registry` was given), `capabilities/web/capability.ts` (the http
token), `pieces/context.md` and an empty `contracts/`. Inside it, `pnpm exec murmur …` (or the package scripts `pnpm dev`,
`pnpm test`, `pnpm check`, `pnpm lint`, `pnpm typecheck`) run the tools.

**Adding murmur to an existing project** works the same way by hand: depend on `murmur`, `@murmur/node`,
`@murmur/transport-memory` and `zod`, dev-depend on `@murmur/cli`, `@murmur/lint`, `oxlint`, `oxfmt`,
`typescript` and `@types/node`, add `"imports": { "#contracts/*": "./contracts/*.ts" }` to `package.json`, extend
`@murmur/node/tsconfig.app.json` from your `tsconfig.json` (the packages ship TypeScript sources as their types and need
its `allowImportingTsExtensions`), and copy the files listed above from a scaffolded app.

## Your first piece

A contract (`murmur new contract GreetingsRequested --domain greetings --kind query --input name:string --output
text:string --name greetings.requested` writes it):

```ts
// contracts/greetings.ts
import { Query } from 'murmur';
import { z } from 'zod';

export class GreetingsRequested extends Query(
  { name: z.string() },
  { text: z.string() },
  { name: 'greetings.requested' },
) {}
```

A piece that answers it (`murmur new piece greeter --handles GreetingsRequested` writes the skeleton, its
`context.md`, a test and a fixture):

```ts
// pieces/greeter/piece.ts
import { Handle, Piece } from 'murmur';

import { GreetingsRequested } from '#contracts/greetings';

export class Greeter extends Piece() {
  @Handle(GreetingsRequested)
  async greet(input: GreetingsRequested): Promise<{ text: string }> {
    this.log.info('greeting', { name: input.name });

    return { text: `hello ${input.name}` };
  }
}
```

Start it with `pnpm exec murmur dev`, then in another shell:

```sh
pnpm exec murmur emit greetings.requested --payload '{"name":"ada"}' --request
```

The piece id is its folder path under `pieces/` (`greeter`, `billing/invoice`, …); `piece.ts` exports exactly one
class.

## The four lanes

A piece declares what it takes from each lane in its `Piece({ … })` header; the runtime resolves everything at boot and
fails fast with one report listing every problem.

| lane             | declared with                                                                 | used as                                                   | notes                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Events**       | `@Handle(Contract)` methods, `emits: [Event, …]`                              | `this.emit(E, payload)`, `this.request(C, input)`         | emitting an undeclared event throws; a handler's return value is its output                                                                                                                  |
| **Contracts**    | `Model` / `Query` / `Command` / `Event` / `Guard` classes in `contracts/*.ts` | imported by producer and consumer via `#contracts/<file>` | zod shapes, exported as JSON Schema; validated on both sides; the class is the type                                                                                                          |
| **Config**       | `config: { key: z.number() }`                                                 | `this.config.key`                                         | resolved from env `MURMUR__<PIECE>__<KEY>`, then `MURMUR__<KEY>`, then `murmur.yaml`, then the schema default; pieces never read `process.env` (lint error)                                  |
| **Capabilities** | `needs: { db: sqlite }`                                                       | `this.db`                                                 | built in: `sqlite`, `kv`, `jobs`, `fetch`, `http` (the web token) from `@murmur/node/capabilities`, plus `this.log`, `this.clock`, `this.ids`; app-local ones live in `capabilities/<name>/` |

Third-party libraries belong inside capabilities, not pieces (a piece imports only what the app's `package.json`
declares); shared pure code lives in `lib/` and is imported as `#lib/<module>` (`murmur new lib <name>`).
`murmur.config.ts` is the only file that knows the whole flock:

```ts
import { defineApp } from '@murmur/node';
import { sqlite } from '@murmur/node/capabilities';
import { createMemoryTransport } from '@murmur/transport-memory';

export default defineApp({
  name: 'my-app',
  transport: () => createMemoryTransport(),
  capabilities: [sqlite],
});
```

## Groups, folders and `context.md`

```
pieces/
  context.md                 app-level context, inherited by every piece
  todos/                     a group: a folder without piece.ts
    context.md               what the group owns; inherited by its pieces
    contracts.ts             internal contracts, visible only inside pieces/todos/**
    scenario.test.ts         a test over the whole subtree (in memory)
    create/                  piece id: todos/create
      context.md  piece.ts  piece.test.ts  fixtures/  *.ts (private helpers)
```

- A piece is a folder with a `piece.ts`; every other file in the folder is private to it. A piece folder may contain
  nested piece folders, which are separate pieces.
- Every piece folder needs a `context.md` with a frontmatter `summary:` line; groups may have one. It says what the piece
  does, why it exists on its own, invariants (idempotency under redelivery!), gotchas and what is out of scope — the
  things an agent regenerating the piece would get wrong without being told. Context inherits downward.
- Sizing: one responsibility, one writer of each table, a handful of handlers. `murmur check` warns past
  ~1 500 source lines, 20 handlers or a 120-line `context.md`, and `murmur ctx` reports `sizing: large|warn|fail` past
  25k/40k/80k tokens. Start coarse and split on pain.

## Running

- `pnpm exec murmur dev` — supervisor + child process: boots the app, restarts it on every change under `pieces/`,
  `contracts/`, `capabilities/`, `murmur.config.ts`, `murmur.yaml` and `.env*`, serves the web UI and the dev API on
  `http://127.0.0.1:4242` (`--port`, `--host`, `--no-ui`, `--no-watch`, `--process <name>`). A broken piece reports a
  boot failure while the UI and static tools keep working.
- The web token (`capabilities/web/capability.ts`) listens on `127.0.0.1:3000`; set `MURMUR__CAP_WEB__PORT` (and
  `MURMUR__CAP_WEB__HOST`) in `.env` or the shell, or `capabilities.web.port` in `murmur.yaml`, to move it.
- `pnpm exec murmur start` — production boot in one process (`mode: 'prod'`, JSON log lines): no watcher, UI or
  replay; the pid you start is the runtime, SIGINT/SIGTERM drain in-flight deliveries and exit 0. `murmur start worker`
  boots one entry of `defineApp({ processes: { worker: { pieces: ['notifier'] } } })`; the web token opens no port when
  no loaded piece serves through it (`capabilities.web.healthz: true` keeps `/healthz`).
  `--env-file <path>` loads env files for both commands.
- While `murmur dev` runs: `murmur tail` (live envelopes; `--failed`, `--piece`, `--contract`), `murmur trace <id>`
  (waterfall of one request: deliveries, retries, replies), `murmur emit <contract> --payload '<json>' [--request]`.
- `pnpm exec murmur doctor` checks Node, pnpm, the installed murmur/oxlint/typescript versions, the lint preset path,
  the transformer and the dev-server lock.

## Testing

- `pnpm exec murmur test [piece|group|glob…]` runs `node:test` over `pieces/**/*.test.ts` and `lib/**/*.test.ts` (a
  group also runs its `scenario.test.ts`); `--watch`, `--name`, `--coverage`, `--json`.
- `await testPiece(P)` (from `@murmur/node/testing`) runs one piece class in isolation with fake log/clock/ids and a
  fake for every need you leave out (sqlite with the app's migrations, a jobs recorder, kv, fetch);
  `createTestApp()` boots the whole app over HTTP on a temp migrated database for admission and end-to-end tests;
  `fakeSqlite`, `fakeKv`, `fakeFetch`, `createTestRuntime` and `loadSubtree` sit next to them:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testPiece } from '@murmur/node/testing';

import { GreetingsRequested } from '#contracts/greetings';

import { Greeter } from './piece.ts';

test('greeter answers', async () => {
  await using t = await testPiece(Greeter);
  assert.deepEqual(await t.deliver(GreetingsRequested, { name: 'ada' }), { text: 'hello ada' });
  assert.equal(t.emitted().length, 0);
});
```

## Checking boundaries

- `pnpm exec murmur check [paths…]` — structure (every piece has `context.md`, handled/emitted contracts exist and are
  visible), boundaries (the `@murmur/lint` oxlint plugin: folder-local imports, no `process.env`, only declared deps,
  one piece class per `piece.ts`, erasable TypeScript only…) and sizing. `--changed` checks only what git sees as changed
  (untracked included), `--types` adds `tsc`, `--json` for tools. Exit 1 on errors.
- `pnpm exec murmur catalog --strict` — the derived table of contracts, pieces, groups and capabilities; `--strict`
  fails on warnings such as a contract that is handled but never emitted. `--format json|md|mermaid`.
- `pnpm lint` (oxlint with the murmur preset + oxfmt) and `pnpm typecheck` in a scaffolded app.

## Getting context

`pnpm exec murmur ctx <piece-or-group>` prints the one-document brief for a piece or group (`--format json` with token
counts per section, `--with code,tests,fixtures,neighbors|all` for inline sources, `--budget <tokens>` to shrink
sections in priority order, `--out <file>`). It reads the code
statically, so it works even when `piece.ts` does not compile or is missing, which is exactly when an agent needs it.

## Web UI

`murmur dev` serves the UI at `http://127.0.0.1:4242`: a folder-tree rail of groups and pieces, **Flock** (graph of
pieces and contracts), **Events** (live stream with a filter language), **Traces** (waterfalls with retries and
replies), **Piece** and **Group** pages (status, counters, latency, policy, context, schema of every contract), and the
**Catalog**. It reconnects and replays recent events after a restart.

## Claude Code plugin

`plugins/murmur` (in the release snapshot or the repo) adds to Claude Code:

- `/murmur-piece <path> [from scratch]` — checks the request is one responsibility, makes sure `murmur dev` runs,
  scaffolds the piece, hands its `murmur ctx` brief to the **piece-writer** agent, runs its tests, emits its fixture and
  confirms the trace, then reviews it.
- `/murmur-contract <name>` — asks at most three questions (producer, consumers, reply), scaffolds the contract, shows
  the catalog before and after.
- `/murmur-review [path|--changed]` — `murmur check --json`, then one read-only **piece-reviewer** per changed piece, with a
  `mergeable | needs-changes` verdict.
- A PostToolUse hook that runs `murmur check` on every edited file under `pieces/` or `contracts/` and blocks the turn
  on errors.
- Agents and skills run the CLI through Bash (`pnpm exec murmur ctx|check|test|catalog|new|emit|trace …`); allow
  `Bash(pnpm exec murmur *)` and `Bash(pnpm test*)` in `.claude/settings.json` to skip the prompts
  ([plugins/murmur/README.md](plugins/murmur/README.md)).

Load it for one session from inside your app:

```sh
claude --plugin-dir <path>/plugins/murmur
```

or install it from `plugins/` as a local marketplace in one step (Claude Code 2.1.275 or later):

```sh
claude plugin install murmur --marketplace <path>/plugins
```

or register the marketplace first and install from it (`--scope project` records it in the project's
`.claude/settings.json`):

```sh
claude plugin marketplace add <path>/plugins --scope project
claude plugin install murmur@murmur
```

## Transports

- `@murmur/transport-memory` — in-process, used by `murmur dev`, tests and single-process apps:
  `transport: () => createMemoryTransport()`.
- `@murmur/transport-amqp` — RabbitMQ 4 (topic exchange `murmur.events`, one durable queue per piece, delayed retry tier
  queues, dead-letter queue `murmur.dead`, publisher confirms, reconnect):
  `transport: () => createAmqpTransport({ url: process.env.AMQP_URL ?? 'amqp://localhost' })` (reading `process.env`
  is allowed in `murmur.config.ts`). Options: `quorum`, `directReplyTo`, `heartbeatSec`, `publishBuffer`.

## Errors, retries and dead letters

A handler that throws is retried with exponential backoff and jitter (default 5 attempts, 200 ms base, 30 s cap; set per
piece with `Piece({ policy: { retry, timeoutMs, concurrency } })` or app-wide in `defineApp({ policy })`). Errors marked
non-retryable — `NonRetryableError`, any error with `retryable === false`, and contract violations — fail at once.
When attempts run out the envelope is **dead-lettered** and `$sys.delivery.deadlettered` is published, so it shows up
in `murmur tail --failed`, traces and the UI. A handler running past `timeoutMs` (default 30 s) gets its `delivery.signal`
aborted and fails with `HandlerTimeoutError` (retryable). `this.request()` rejects with `RequestTimeoutError` after
`requestTimeoutMs` (default 10 s), and with `RemoteError` (carrying the responder's error name, code and message) when
the responder failed for good. Emits started in a handler are awaited before the delivery is acknowledged.

## Documentation

- [docs/piece-authoring.md](docs/piece-authoring.md) — writing pieces, sizing heuristics, idempotency
- [docs/capability-authoring.md](docs/capability-authoring.md) — writing capabilities
- [docs/envelope.md](docs/envelope.md) — the wire envelope
- [docs/dev-protocol.md](docs/dev-protocol.md) — the dev server HTTP/SSE protocol
- [docs/cli.md](docs/cli.md) — every CLI command and flag
- [docs/ingress.md](docs/ingress.md) — edge pieces: `@Serve`, the web token, guards, `req.read`/`req.reply`, errors,
  idempotent routes, SSE
- `examples/todo-api` — the v0.3 app of [docs/api-preview.md](docs/api-preview.md): contract classes, domain pieces
  `todos` and `stats`, guard piece `auth`, job piece `notifier` (the `worker` process), edges `api/rest` and
  `api/feed` (SSE), `lib/etag.ts`, piece and e2e tests

## Releasing

murmur is distributed through a private npm-compatible registry; versions move in lockstep (all packages share one
version). Packages publish compiled `.js` beside their `.ts` sources, because Node refuses to strip types under
`node_modules`: each package's `prepack` emits the `.js` files (`scripts/release/emit.ts`, tsc with
`rewriteRelativeImportExtensions`) and `postpack` removes them again; `publishConfig` points `exports`/`bin` at the
`.js` files and keeps the `.ts` sources as `types`. `@murmur/ui` builds its `dist/` on `prepack`.

From the repository root:

```sh
# publish every package in dependency order (refuses when a version is already on the registry)
NPM_REGISTRY=http://127.0.0.1:4873/ pnpm release:publish

# install the just-published cli in an empty directory and check `murmur --version`
pnpm release:verify http://127.0.0.1:4873/ ../murmur-verify

# assemble a release directory for a team without repo access
pnpm release:snapshot ../murmur-0.3.0
```

`release:publish` runs `pnpm publish --registry $NPM_REGISTRY --no-git-checks` per package. It uses `NPM_TOKEN` when
set; otherwise it registers a throwaway user on the registry (verdaccio allows this) and publishes with that token. A
version that is already on the registry is never replaced: `release:publish` refuses and names those versions; bump the
version to ship changed code, or pass `--force` to publish only the missing packages. Re-publishing the same version
into a fresh registry is not enough either, because pnpm caches registry metadata per registry URL and keeps installing
the old tarball: after every publish the script prints that warning with the cache folders to remove.
`release:verify <registry> <dir>` installs `@murmur/cli` at the workspace version into `<dir>` (empty or missing) with its
own pnpm cache (`XDG_CACHE_HOME=<dir>/.cache`, so a stale user cache cannot hide what the registry serves) and fails
unless `murmur --version` prints that version.

`release:snapshot <dir>` writes `README.md` (this file without its "Releasing" and "Repository" sections), `LICENSE`, `docs/`, `plugins/` (the Claude Code plugin and its local
marketplace), `examples/` (workspace links pinned to the released versions), `packages/*.tgz` (every package packed;
`--no-tarballs` skips them) and `RELEASE.md` (versions, git sha, install and publish-order instructions). It never
copies `.agents/`, `AGENTS.md`/`CLAUDE.md`, `.git`, `node_modules`, `.murmur/` or databases.

A local registry for trying a release: `scripts/release/verdaccio.yaml` keeps `murmur` and `@murmur/*` local-only and
proxies everything else to npmjs.

```sh
docker run -d --name murmur-verdaccio -p 4873:4873 \
  -v "$PWD/scripts/release/verdaccio.yaml:/verdaccio/conf/config.yaml:ro" verdaccio/verdaccio:6
NPM_REGISTRY=http://127.0.0.1:4873/ pnpm release:publish
```

## Repository

`packages/` holds the eight packages (`murmur` core, `@murmur/node`, `@murmur/transport-memory`,
`@murmur/transport-amqp`, `@murmur/lint`, `@murmur/dev-protocol`, `@murmur/cli`, `@murmur/ui`),
`plugins/murmur` the Claude Code plugin, `examples/todo-api` the example app. `pnpm install && pnpm check` runs lint,
typecheck and every test; `pnpm build:ui` builds the UI; `pnpm example` runs the example under `murmur dev`.

## License

MIT, see `LICENSE`.
