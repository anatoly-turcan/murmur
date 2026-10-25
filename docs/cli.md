# CLI (`murmur`)

`@murmur/cli`, bin `murmur` (`bin/murmur.js` in the published package, linked as `node_modules/.bin/murmur`); run it
as `pnpm exec murmur <command>` from the app (`pnpm start` runs `murmur start` behind a run-script wrapper). Static
commands read the app on disk; live commands talk to a running `murmur dev`.
Every command finds the app root by walking up to `murmur.config.ts` (or takes `--cwd`).

```
murmur <command> [args] [flags]
global: --cwd <dir>  --json  --no-color  --env-file <path>  -q/--quiet  -h/--help  -V/--version
```

| Exit | Meaning                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 0    | ok                                                                                                        |
| 1    | findings: failed tests, `check` errors, `ctx` over the fail cap, `catalog --strict` warnings, files exist |
| 2    | usage: unknown command/flag, bad value, unknown piece or trace, no app root                               |
| 3    | no dev server running (live commands)                                                                     |
| 4    | the app does not boot or cannot be described (catalog errors, boot report)                                |
| 5    | internal error, Node < 26, `murmur dev` already running for this root                                     |

- `--json` prints one JSON object per line on stdout, each with a `kind` (`ctx`, `check`, `catalog`, `test`, `trace`,
  `emit`, `doctor`, `error`). Errors go to stdout as `{ kind: 'error', code, message, hint? }` in JSON mode, else to
  stderr as `murmur: <message>` plus `hint:`.
- `--env-file` (repeatable) replaces the default `.env` and `.env.local` for `dev` and `start`; missing files are
  skipped. `NO_COLOR` or `--no-color` disables colour. Running `murmur` with no command prints usage and exits 2.

## Commands at a glance

| Command                         | Kind       | What                                                                                 |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `dev`                           | live       | supervise the app, watch files, serve the dev API + UI                               |
| `start`                         | app        | boot the app in prod mode until SIGINT/SIGTERM                                       |
| `migrate`                       | app        | apply the boot migration list once (`migrate(root, env?)`), exit 4 on a failing file |
| `tail`                          | live       | stream envelopes                                                                     |
| `trace <id>`                    | live/files | waterfall of one trace                                                               |
| `emit <Contract>`               | live       | publish or request through the dev server                                            |
| `catalog`                       | static     | contracts, pieces, capabilities, warnings                                            |
| `ctx <id>\|lib/<m>`             | static     | the agent brief for one piece, group or lib module                                   |
| `check [paths…]`                | static     | structure + lint + oxfmt (+ types)                                                   |
| `new piece\|contract\|lib\|app` | static     | scaffold (`lib <name>`: `lib/<name>.ts` + a test importing `#lib/<name>`)            |
| `test [piece\|glob…]`           | static     | run `node --test` on piece tests                                                     |
| `doctor`                        | static     | environment report                                                                   |

## `murmur dev`

```
murmur dev [--port 4242] [--host 127.0.0.1] [--open] [--no-ui] [--no-watch] [--watch-tests] [--process <name>]
           [--replay 5000] [--redact] [--payload-cap 16kb] [--trace-dir .murmur/traces] [--inspect]
```

Runs the app in a child process (dev mode) and restarts it on changes under the app (`--watch-tests` also on
`*.test.ts`). Serves the [dev protocol](dev-protocol.md) and the web UI at `http://<host>:<port>/` (`--no-ui` turns the
UI off, `--open` opens a browser). `--process` boots one `defineApp({ processes })` entry; `--replay` sizes the buffer;
`--payload-cap` and `--redact` shape payloads in frames; `--inspect` passes `--inspect` to the child. Writes
`.murmur/dev.json` while running and removes it on exit. A boot failure is printed and the watcher keeps going; fix the
file and it restarts. Exit 0 on SIGINT/SIGTERM, 5 if another `murmur dev` holds this root. A signal to the murmur pid
alone (the banner's `pid=`) is enough: the child gets SIGTERM and drains (2 s + 0.5 s, SIGKILL at 3.5 s), the lock goes,
both ports are free. From a script, send SIGTERM to `pnpm dev &`: a non-interactive shell starts background jobs with
SIGINT ignored, and pnpm does not pass on a SIGINT it ignores.

## `murmur start`

`murmur start [<process>]` — supervisors run `pnpm exec murmur start` or `node_modules/.bin/murmur start`; `pnpm start`
adds a run-script wrapper in front of the runtime that exits 143 on SIGTERM. The process you start is the runtime: it
registers the app loader in-process, loads env files, boots the app in prod mode and prints `murmur start  pieces=N
pid=P` with its own pid; there is no child. SIGINT or SIGTERM to that pid stops it gracefully (ingress first, drain,
capabilities) and exits 0. Node flags go straight to it (`node --max-old-space-size=4096 node_modules/.bin/murmur
start`). Boot failure prints the boot report and exits 4. `murmur start worker` boots one `defineApp({ processes: {
worker: { pieces: ['notifier'] } } })` entry (globs are piece ids, else `process-invalid`; no name: all; banner
`process=worker`); `jobs: false` claims no jobs; an unserved ingress stays off unless `capabilities.web.healthz: true`.

## `murmur tail`

```
murmur tail [--piece <glob>] [--contract <glob>] [--trace <id>] [--failed] [--internal] [--since <seq|duration>]
            [--no-follow] [--payload] [--json]
```

Follows the live stream (until SIGINT, exit 0) or, with `--no-follow`, prints the buffered envelopes and exits.
`--internal` includes `$sys.*`; `--failed` keeps only frames of failed deliveries (attempts and dead letters); `--since 120` or
`--since 30s`; `--payload` prints payloads; a job run prints as `job <contract> → <piece>`. Exit 3 without a dev server.

## `murmur trace`

`murmur trace <traceId|prefix> [--from <file.ndjson|dir>] [--json] [--payload] [--width 100]` — renders the trace
waterfall (envelopes, deliveries with attempts and outcome, replies). An HTTP request's trace is rooted at its ingress
entry, `$ingress.http  (http)` with `{ method, path, binding }`, and the guard requests are its first children; a
guard reply that is a `Rejection` reads `rejected 401` (JSON: `reply.rejected`). Looks in the dev server first, then
`.murmur/traces/` or `--from`. Exit 3 when not found and no dev server runs, 2 when not found otherwise, 2 for an
ambiguous prefix (candidates listed).

## `murmur emit`

`murmur emit <Contract> [--payload '<json>' | --fixture <file>] [--request] [--timeout 5000]` — publishes through
the dev server (`POST /api/emit`). Prints `traceId=… envelopeId=… Nms` and, with `--request`, the reply. The payload
defaults to `{}`. Exit 2 for invalid JSON, an invalid payload or an unknown contract; 3 without a dev server; 4 when
the app is down; 1 for a remote error or timeout.

## `murmur catalog`

`murmur catalog [--format table|json|md|mermaid] [--strict] [--group <prefix>] [--contract <name>]` — derives the
catalog from code: contracts with emitters and handlers, pieces, capabilities, warnings (`subscribed-never-emitted`,
`emitted-never-subscribed`, `requested-never-handled`, `missing-context-md`, `missing-summary`, `missing-tests`). Exit 4 on catalog errors (duplicate contract names, bad piece
ids), 1 with `--strict` when there are warnings. JSON contracts list `emitters` (events) and `requesters` (call
sites, shorthand routes, guards) apart; the table column `requested / emitted by` shows both. `--format mermaid`
puts edge pieces in one subgraph per http token and draws guard edges dashed. Each run (like `murmur dev`) refreshes the lane snapshot
`.murmur/catalog-snapshot.json` that `ctx` reads when a `piece.ts` is absent
([piece-authoring.md](piece-authoring.md#lane-lines)).

## `murmur ctx`

```
murmur ctx <id>|lib/<module> [--with code,tests,fixtures,neighbors|all] [--budget <tokens>] [--format md|json]
           [--withhold-code] [--out <file>]
```

Assembles the minimal brief for a piece or group: header, rules, context chain, own `context.md`, `## Files`, owned
storage, contracts (zod source), Serves, catalog rows, capability docs, config keys, footer. No code: `## Files` lists
every file of the piece folder (path from the app root, line count, token estimate) and ends with "Read the files the
task touches; the brief carries what the folder cannot tell you." A folder with no file besides its `context.md` (a
group) gets no `## Files`. Tokens are estimated as `ceil(chars / 4)`.

- `--with` adds sections inline (comma list): `code` (`## Code`: `piece.ts`, then the private files), `tests`,
  `fixtures`, `neighbors`; `--with all` adds the four. Code follows `## Files`; tests, fixtures and neighbors come last.
- Sizing is judged on the full brief (every section at level 0, code and tests included), whatever is printed. The
  footer line reads `tokens: <printed> printed, full <N> (<tier>); tiers large ≥ …` against `limits.ctxLargeTokens`
  (25 000, footer only), `limits.ctxWarnTokens` (40 000) and `limits.ctxFailTokens` (80 000); a `- not printed:`
  line names the sections left out and the `--with …` flag that adds them. At warn, one stderr line names the full size and the heuristics page
  ([piece-authoring.md](piece-authoring.md)), exit 0; at fail the brief is still printed and the exit is 1.
- `--budget N` shrinks the printed sections by priority until the brief fits and skips the caps (no stderr line, no
  exit 1); the footer still names the tier: `budget: N (P tokens printed, full F (<tier>); caps skipped)`. `--budget 0` = no shrinking, no caps.
- `--format json` → `{ kind: 'ctx', piece, sections: [{ id, title, tokens, level, text }], tokens, fullTokens, budget,
  overBudget, sizing, limits, error, regeneration }` (`tokens` = printed, `sizing` from `fullTokens`). ctx never imports a class `piece.ts`: its sections come from static analysis, so
  a `piece.ts` that throws at import still gets a full brief; `error` carries an import error of a `piece.ts` that
  declares no piece class.
- `## Storage` appears when the piece's or an ancestor's `context.md` names tables in its Needs (`Needs: sqlite (table
  todos)` or a `## Needs` section, verbs `table(s)`/`reads`/`writes`/`owns` inside parentheses; the lane-line grammar in
  `piece-authoring.md`, shared with regeneration). Per table it inlines
  the `CREATE TABLE` / `ALTER TABLE` / `CREATE INDEX` statements and says where they came from: the sqlite
  `migrations` dir from `murmur.yaml`, else any `*.sql` file in the app, else a `CREATE TABLE` string in the piece's
  tests; plus one example row from a literal `INSERT` in a test or `fixtures/*.sql` (the piece's own first).
- `<id>` may carry the `pieces/` prefix. The header's commands are the ones to run from the app root:
  `pnpm exec murmur test pieces/<id>`, `pnpm exec murmur check --fix pieces/<id>` (oxfmt + lint autofix, listed
  before check so the writer runs it first), `pnpm exec murmur check pieces/<id>`; the footer's reproduce line too.
  Below them an import skeleton lists the imports the piece may use; a piece that needs `sqlite` and has private files
  (or is being regenerated) also gets `import type { Sqlite } from '@murmur/node/capabilities'` for a repository
  that types the handle.
- `--withhold-code` leaves `piece.ts` and the private files out of `## Files` and `--with code` (a regeneration brief;
  combine it with `--with` freely); a folder with `context.md` or
  tests but no `piece.ts` (a leaf under regeneration) gets the same brief automatically. The header lists needs /
  listens / emits / requests and the source of each (catalog, catalog snapshot, `context.md` lane lines, tests), so
  capability docs, catalog rows and fixtures stay; JSON adds `regeneration: { reason: 'withheld' | 'absent', lanes }`
  (`null` otherwise). The header (and the `## Code` hint with `--with code`) names the headings to write from. `## Serves` stays: routes with their
  guards from the catalog (or, when `piece.ts` is absent, keys from the serves lane with guards unknown), token
  defaults, `WebRequest` and the error table. A bare `Needs: sqlite` takes its field name (`db=sqlite`) from the tests
  or the snapshot. Private files over 300 lines shrink to signatures first.
- The footer's printed count and `tokens` in JSON are one number, the footer's full count, `fullTokens` and the stderr
  sizing line another (the footer counts itself in both). Unknown id → exit 2 with close matches.
- `lib/<module>`: header, `## Signatures`, `## Tests` (JSON `{ kind: 'ctx', module, sections, tokens }`); a piece importing `#lib/x` gets `## Lib`.

## `murmur check`

`murmur check [--changed] [--types] [--fix] [--json] [paths…]` — structure findings (context.md, frontmatter, piece
ids, annotations, sizing caps, `murmur.yaml` syntax), lint (oxlint with the
app's own `.oxlintrc.json` passed as is, so its overrides apply exactly as in `pnpm lint`, or the `@murmur/lint`
preset when the app has none, see [piece-authoring.md](piece-authoring.md); then `oxlint --type-aware -c
@murmur/lint/type-aware` for the exhaustive-switch rule; every `murmur/*` finding plus every other error) and
`oxfmt --check` (`oxfmt/format`, one error per unformatted file; an oxfmt that cannot run, a broken `.oxfmtrc.json` or
a file it cannot parse, is one `oxfmt/run` error), so a folder that passes `check` passes the app's `pnpm lint`; with `--types`, `tsc`. Paths scope the
check to pieces/folders (a path under `contracts/`, `capabilities/` or `lib/` checks the whole app); `--changed` adds
files changed against `HEAD` plus untracked files. `--fix` formats, applies the lint fixes and formats again. A route finding (`binding-conflict`, `route-shadowed`, `route-family-split`) is in scope when any piece it
names is, so checking the newcomer shows it; `route-family-split` names the piece with the most routes in the family
as the owner and is anchored at each other piece. A `@Serve` whose token is not an http token the extractor can
follow (an import that resolves to no file, a local alias, a non-http token) or whose verb or path is not literal is a
`serve-unresolved` error at the decorator: check cannot see that route, so it does not stay silent about it. JSON: `{ kind: 'check', ok, findings: [{ rule, severity, file, line, col,
message, help?, pieces? }], summary: { structure, lint, types } }` (`lint` counts the lint and oxfmt
findings). Exit 1 when any finding is an `error` (sizing findings are warnings), 4 when the app cannot be described.

## `murmur new`

```
murmur new piece <path> [--handles C[,…]] [--emits C[,…]] [--needs field=cap[,…]] [--config key:type[,…]]
                        [--serve '<verb> /path[=Contract]'[,…]] [--edge] [--idempotent] [--summary "…"] [--dry-run] [--force]
murmur new contract <ClassName> --domain <file> --kind query|command|event|guard [--input key:type,…]
                    [--output key:type,…|Model|Model?|Model[]] [--name <wire>] [--dry-run]
murmur new lib <name> [--dry-run] [--force]
murmur new app <dir> [--transport memory] [--registry <url>]
```

- `piece.ts` is `export class <Name> extends Piece({ needs, config, emits })` with one `@Handle(C)` method per
  `--handles` contract (`input: C`, no `delivery` parameter, no log line, a typed return stub; a guard answers
  `Out | Rejection`, `return reject(401, …)` without an `authorization` header, tested both ways; `--idempotent` adds
  `delivery: Delivery` and a claim-first `handled` table to command and event handlers, queries stay plain). `--emits` events go to `emits: […]` and are emitted by the
  first handler; query/command contracts there are requested (`this.request`) and answered in the test with
  `t.respond`. `--serve 'get /x/:id'` writes the method form (`@Serve(web.get('/x/:id'))`, `req: WebRequest`, the first
  method reads the first requested contract's input with `req.read({ body | params | query: C.input })` and answers
  `req.reply(output)`, `Promise<HttpResult>`); `--serve 'post /x=CreateX'` writes the class-level shorthand. Tests use `await testPiece(Class)` (built-in needs faked;
  an app capability is passed as `{ field: {} as never }`) and, for routes, `t.fetch(new Request('http://app/x/1'))`.
  `--needs db=sqlite` also writes an empty `schema.sql` (the sqlite fake applies the app's migration list). `context.md` carries `Handles:`, `Emits:`, `Requests:`, `Serves:`, `Needs:`, `Storage:`.
- `contract --kind` appends `export class <ClassName> extends Query|Command|Event|Guard(…) {}` to
  `contracts/<domain>.ts`, adding the factory to the `murmur` import; `--output X?` is `X.nullable()`, `X[]` is
  `X.array()` (the Model must be declared in that file), `key:type,…` an inline shape (each item needs `:type`; a
  bare word is a usage error, exit 2); `--kind guard` takes one Model or writes the shape as `<ClassName>Output`. The wire name is
  `<domain>.<ClassName>` unless `--name` sets it. A contract name is a PascalCase class name (a dotted name is a usage
  error, exit 2); exit 1 if the class exists.
- `piece` writes `context.md` (frontmatter + sections), `piece.ts`, `piece.test.ts` and a group `context.md` for new
  parent folders. Config types: `string`, `number`, `boolean`, `url`. The scaffold starts green and already formatted
  (a handler head past the print width wraps its parameters). Sample payloads (the fixture, emit and reply stubs) follow the contract's JSON Schema:
  strings `"example"` (or a value of their `format`, fitted to length bounds), numbers `1` (moved into
  `minimum`/`maximum`), booleans `true`, arrays `[]` (or `minItems` item samples), enums their first value, nested
  objects recursively. Exit 1 if `piece.ts` exists (use `--force`).
- `app` creates a new app (memory transport) in an empty directory, with a `README.md` of its commands,
  `capabilities/web/capability.ts` (`http({ guards: [], errors: { input } })` with the default failure map spelled out, + `WebRequest`), the `#contracts/*`, `#capabilities/*` and
  `#lib/*` imports, so `new piece --edge`/`--serve` compiles and tests right away; its `.oxlintrc.json`
  extends the `@murmur/lint` preset. `--registry` also writes its `.npmrc` and a README `Registry` section. Exit 1 if the directory
  is not empty.
- Human output ends with one `next: <command>` line per step (`pnpm exec murmur …`); `--json` carries them as `next`.

## `murmur test`

`murmur test [piece|glob…] [--watch] [--name <pattern>] [--coverage] [--json]` — runs `node --test` in the app root.
No target: `pieces/**/*.test.ts`, `contracts/**/*.test.ts`, `capabilities/**/*.test.ts`, `lib/**/*.test.ts`. A piece id runs that piece's
tests; a group id runs its `scenario.test.ts` and every descendant's tests; anything else is a glob. JSON:
`{ kind: 'test', passed, failed, skipped, durationMs, failures: [{ name, file, message, stack }] }`. Exit 1 on any
failure. Tests run under the app loader from any cwd. `--coverage` measures `pieces/**` minus `**/*.test.ts` and
prints Node's table; with `--json` it adds `coverage: [{ file, linePercent, uncoveredLines }]`. Tests run in child
processes by design (`node --test` isolates each file); `murmur test` forwards SIGINT/SIGTERM to them and exits with
their code (130 when one dies by a signal). `--json --coverage` re-runs the CLI once with `--enable-source-maps`
because Node's runner reads that flag only at startup.

## Loader

Every process that runs app code (`dev` child, `test` and its workers, the describe worker behind
`ctx`/`catalog`/`check`) gets `--enable-source-maps --import <@murmur/node/register resolved from the app root>?root=<app root>`;
`start` imports the same URL in-process before it loads `murmur.config.ts` (`module.register()` is deprecated in
Node 26, DEP0205; the register module uses the in-thread `module.registerHooks`). `dev` keeps a child because it
restarts the app on changes; the describe worker is a child so app imports never stay cached in the CLI.
The hook sends every `.ts` and `.mts` file under the app root and outside `node_modules` through `@swc/core`
(standard 2023-11 decorators, `using` lowered, import attributes kept, inline source maps) and loads it as an ES
module; `.cts` is not transformed. Framework packages and dependencies load untouched, including their own
`@swc/helpers` imports. The transform also compiles `enum`, `namespace` and parameter properties; lint
(`murmur/erasable-syntax-only`) and `tsc` (`erasableSyntaxOnly`) are what forbid them. `MURMUR_TRANSFORM=esbuild` switches to esbuild (install `esbuild@0.28.2` in the app; coverage then marks
decorator lines as uncovered). Apps installed with pnpm 12 need `allowBuilds: { '@swc/core': true }` in
`pnpm-workspace.yaml`; `murmur new app` writes it.

## `murmur doctor`

Reports Node (needs ≥ 26), TypeScript mode, pnpm, the app root, installed `murmur`, `@murmur/node`, `@murmur/cli`,
`zod`, `oxlint`, `typescript` versions, the dev lock (`none | live | stale`), whether
`.oxlintrc.json` `extends` resolves, the active transformer (`MURMUR_TRANSFORM`) with its package version and the
platform binary that loaded, a probe transform of a decorated class, and the resolved register URL (JSON:
`transformer: { name, package, version, binary, registerUrl, works, error }`). Exit 1 when any of Node, the root, the
lint config or the transform probe is wrong.

## Docs

These pages ship inside `@murmur/cli` (`docs/`, in an app `node_modules/@murmur/cli/docs/<page>.md`); the ctx brief
links them from there. Inside the murmur monorepo the repo's `docs/` is used instead.
