# Framework issues (murmur 0.2.1)

1. Built-in `sqlite` capability: opens `new DatabaseSync(path)` without a busy timeout and uses a deferred `BEGIN`,
   so two processes writing one file fail with `database is locked (517)`. Worked around by `capabilities/db`
   (`timeout: 5000`, WAL, `BEGIN IMMEDIATE`, same ALS-aware handle shape).
2. `GET /healthz` is a built-in route and cannot be overridden (the spec wants its own body and a 503
   `database_unavailable`). Worked around by `capabilities/front`, which answers `/healthz` itself.
3. The http request does not expose the socket peer address (needed for per-client rate limiting). Worked around by `capabilities/front`, which forwards it as `x-taskwell-peer`.
4. Ingress capabilities start in every process, so the worker (`--only '{worker/**,app/scheduler}'`) still starts
   the http server; `bin/worker` binds it to an ephemeral loopback port (`MURMUR__CAP_WEB__PORT=0`) that serves
   nothing.
5. `RunContext` storage (`runContext`) is not exported from `@murmur/node`, so a capability test cannot run code
   "inside a delivery" without `testPiece`; `capabilities/db/capability.test.ts` imports
   `node_modules/@murmur/node/src/context.js` directly for the nested-transaction tests.
6. `RetryPolicy` requires a `jitter` field in `defineApp({ policy: { retry } })`, but the documented policy examples
   omit it, so `tsc` fails with "Property 'jitter' is missing". `murmur.config.ts` sets `jitter: 0.5` explicitly.
7. The CLI's `package.json` `bin` is `bin/murmur.js` (not `murmur.ts`); `bin/api` and `bin/worker` call that file.
8. With zero routes (no pieces) the http capability renders unmatched-path 404/405 with the framework's default
   envelope (including `traceId`), because the router takes its error settings from the first served route. Once
   edge pieces exist the app's envelope applies; `capabilities/web/capability.test.ts` tests the envelope directly.
9. `murmur start` relaunches itself as a child process with the loader flags unless `process.execArgv` already holds
   the exact register URL (`isLoaderActive`), so a signal sent to the started PID reaches only the launcher.
   `bin/api` and `bin/worker` avoid it by computing that URL (`@murmur/node/register` resolved from the app root,
   `?root=<root>`) and running `node --enable-source-maps --import <url> .../murmur.js start`.
