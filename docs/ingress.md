# Ingress

Ingress belongs to pieces. An **edge piece** declares the routes it serves with `@Serve(binding)` and calls **domain
pieces** through `this.request(...)`; nothing route-like lives in `murmur.config.ts` and there is no `routes.ts`.

- The app's configured http token lives in `capabilities/web/capability.ts`: `http({ guards })` plus
  `export type WebRequest = RequestOf<typeof web>`, the one `typeof` of the app. Pieces import it as
  `#capabilities/web`.
- Class-level `@Serve(web.get('/todos'), ListTodos)` forwards to a contract; a method `@Serve(web.get('/todos/:id'))`
  takes `req: WebRequest` and returns a `Response` or JSON. Status codes and headers are plain code in the edge.
- Guards are request contracts answered by a normal piece; a refusal is a returned `reject(401, …)`, never a throw.
- Every route has one owner; conflicts and shadowed routes are boot errors and `murmur check` findings.

## The web token

```ts
import { http, type RequestOf } from '@murmur/node/capabilities';

import { Authenticate, RateLimit } from '#contracts/auth';

const web = http({ guards: [Authenticate, RateLimit] });

export default web;

export type WebRequest = RequestOf<typeof web>;
```

`http({ name?, guards?, errors?, maxBodyBytes?, responseHeaders?, log? })` returns a capability token with binding
makers; `responseHeaders(auth)` adds headers to every response after admission passed (success, error, null → 404),
`log(auth)` adds fields to the one built-in access line per request, `access { method, path, status, ms, traceId }`
(`log: (auth) => ({ user: auth.userId ?? null })`; `auth` is partial: a route may skip a guard). `name` defaults to
`web`, so its config is `capabilities.web.port` (3000) / `host` (127.0.0.1) / `trustProxy` (false) / `enabled` (true) in
`murmur.yaml` or `MURMUR__CAP_WEB__PORT`. It is discovered like any app-local capability; `murmur.config.ts` lists only
built-ins (`capabilities: [sqlite]`). The server listens only when a loaded piece serves through the token (`murmur
start worker` of `defineApp({ processes })` with no edge opens no port; `healthz: true` keeps a listener with only
`/healthz`) and `enabled` is not `false`; a log line `web not started: <reason>` says why it did not. `GET /healthz`
answers `{ ok: true }` (open, GET and HEAD) unless a piece serves the literal path `GET /healthz`: then that route wins,
guards and all. A param or wildcard route matching `/healthz` (`/:page`, `/*rest`) does not replace it.

## Bindings

`web.get | post | put | patch | delete(path, { status?, guards?, skip?, meta?, timeoutMs?, maxBodyBytes? })` and
`web.raw(method, path)`. Paths are `/todos/:id`; a raw binding may end in `/*rest`. Query strings are not part of the
key. `HEAD` is answered by the `GET` binding without a body; `OPTIONS` lists the served methods.

```ts
@Serve(web.get('/todos'), ListTodos)
@Serve(web.post('/todos/:id/complete'), CompleteTodo)
@Serve(web.delete('/todos/:id', { status: 204 }), RemoveTodo)
@Serve(web.get('/stats', { skip: [Authenticate] }), GetStats)
export class RestApi extends Piece() {
  @Serve(web.patch('/todos/:id'))
  async update(req: WebRequest): Promise<HttpResult> {
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

- **Shorthand** (above the class): params < query < JSON body read into the contract input (failures map like
  `req.read`, by the part that supplied the failing field), then `this.request(C, input)`; the output renders like a
  returned outcome. Every `:param` must be a field of the contract input (tsc and `binding-param-not-in-input`). Write
  a method once a route needs a header, an etag or a second status.
- **Method**: `req: WebRequest`, an optional `delivery: Delivery`, returns `Promise<HttpResult>`: a `Response` (sent as
  is), an output (`200 application/json`, or the binding's `status`), a `Rejection` (rendered through the envelope),
  `undefined` (204) or `null` (404 `not_found`).
- Read the file as "shorthands above the class, methods inside". One more endpoint costs a line or about six.

## `HttpRequest`

`method`, `url`, `path`, `params`, `query`, `headers`, `peer`, `ip`, `auth`, `traceId`, `signal`, `raw` (the web
`Request`; taken before the body is read it streams the unread body, still capped at `maxBodyBytes`; a raw binding
reads its body here: `req.raw.json()`, `req.raw.formData()`), `read(parts)`, `reply(outcome, options)`.

- `req.peer` is the socket's remote address (`'127.0.0.1'`, `'::1'`); `req.ip` is the first `X-Forwarded-For` entry
  when `capabilities.web.trustProxy: true` is set in `murmur.yaml` or `MURMUR__CAP_WEB__TRUST_PROXY=true` (behind a
  proxy you run), else `req.peer`. `t.fetch` and
  `createTestRuntime().fetch` report `127.0.0.1` for both.

- `const { params, query, headers, body } = await req.read({ params?, query?, headers?, body? })` is the one way to
  read a request. Each part is a zod object or shape; parts are read in that order and the first failing part answers
  with its `errors.input` mapping before anything is published. `params` and `query` strings that fail are retried
  JSON-decoded (`?done=false` satisfies `z.boolean()`, `'3'` a number); the query is strict (an unknown key or a
  repeated single-valued key fails; `z.array()` fields take repeats); headers are read by lower-case name and a
  missing optional header is `null` (`IfMatch` from `murmur` reads `if-match: "7"` as `'7'`, `*` as `*`); the body is
  read for POST/PUT/PATCH/DELETE: empty is `{}`, a non-JSON content type fails as `mediaType`, invalid JSON as
  `json`, a non-object body as `body` with one root issue.
- `req.reply(outcome, { status?, headers?, etag? })` is the one response tail: a `Rejection` renders with its
  status/code/details/headers, `null` is 404, `undefined` 204, an object JSON with `status` or the route's. `etag` is a
  value or `(body) => value`, sent as a strong ETag (`etag(value)` from `murmur` quotes it); a GET/HEAD whose
  `If-None-Match` matches answers 304 with the etag and no body. Returning the outcome directly is the same without
  headers or etag.
- `req.auth` is the merged guard outputs, typed from the token: `Principal & Quota` with the defaults above. A route
  that changes guards names its auth with classes: `req: HttpRequest<Quota>` after `skip: [Authenticate]`,
  `HttpRequest<Principal & Quota & AdminGrant>` with `guards: [RequireAdmin]`; tsc rejects a mismatch. With every guard
  skipped `req.auth` is `undefined`.
- `req.signal` aborts when the client disconnects or the response was sent.
- Refuse in the edge with `return reject(403, '…')`; a domain handler whose contract output is `rejectable(Model)`
  refuses the same way and the edge renders it unchanged.

## Errors

Bodies always carry a stable `code` and the `traceId`; class names never appear:

```json
{ "error": { "code": "not_found", "message": "nothing found at /todos/nope" }, "traceId": "1f3c…" }
```

| Cause                                             | Status | `code`                                     |
| ------------------------------------------------- | ------ | ------------------------------------------ |
| `req.read` params                                 | 404    | `not_found`                                |
| `req.read` query, headers, json, body             | 400    | `invalid_input`                            |
| `req.read` body with a non-JSON content type      | 415    | `unsupported_media_type`                   |
| a returned `Rejection` (guard, edge or domain)    | as set | as set (`unauthorized`, `rate_limited`, …) |
| a returned `null`                                 | 404    | `not_found`                                |
| body over `maxBodyBytes` (1 MiB)                  | 413    | `payload_too_large`                        |
| no responder for a requested contract             | 501    | `not_implemented`                          |
| a domain handler or a guard threw (`RemoteError`) | 502    | `upstream_failed`                          |
| request or handler timeout                        | 504    | `timeout`                                  |
| anything else thrown in the edge                  | 500    | `internal`                                 |

The input rows are the defaults of `errors.input`; a token sets its own per part, and renames zod issue codes:

```ts
http({
  errors: {
    envelope: ({ code, message, issues, details }) => ({
      error: { code, message, details: details ?? issues },
    }),
    input: { body: { status: 422, code: 'validation_failed' }, issueCodes: { too_small: 'too_short' } },
  },
});
```

Issues keep zod's `code` and params, `{ path: ['title'], code: 'too_short', message, origin: 'string', minimum: 1,
inclusive: true }`; a refinement's `params` are spread into its issue (`params: { code: 'x' }`). 5xx bodies carry
`cause: { name, message }` under `murmur dev` only; `start` logs it under the trace id. `errors.status` maps an
uncaught error by `error.name`: `{ MyError: { status: 409, code: 'conflict' } }`. Shared pure code (formatting, codecs,
row types) lives in `lib/` as `#lib/x`; I/O and state live in a capability. A client that leaves mid-request gets a
bodiless 499 and a debug line, not an error.

## Guards

```ts
export class Authenticate extends Guard(Principal) {}

@Handle(Authenticate)
async authenticate(input: Authenticate): Promise<Principal | Rejection> {
  const token = bearer(input.headers['authorization']);
  if (token === null) {
    return reject(401, 'missing bearer token');
  }

  return { userId: token, roles: [] };
}
```

- `bearer(header)` is from `@murmur/node/lib` (with `canonicalJson` and `sha256`): the token of `Bearer <token>`, else
  `null`.
- A guard's input is `{ transport, operation, headers, params, peer, ip, meta, prior }` (`operation` = binding key,
  headers lower-cased, `peer`/`ip` as on `req`); its output is the model or a `Rejection`
  (`reject(status, message, { code?, details?, headers? })` from `murmur`; `headers` such as `retry-after` go on the
  response).
- Guards run in order; the body is read after them. The token's guards, then the route's extras, one at a time, once
  per request; the first rejection answers and the rest do not run. Non-rejection outputs merge onto `req.auth`; two
  guard models sharing a key is a boot error (`guard-output-overlap`). `skip: [G]` drops a default on one route,
  `guards: [G]` adds one. An oversize body is refused with 413 only after the guards passed (401 before 413).
- `Guard(Out, { after?, optional?, meta? })`: a guard that needs another's output lists it. `after: [Authenticate]`
  must run first and its output is `input.prior` (typed, non-nullable); `optional: [Authenticate]` runs first when the
  route keeps it, its fields `| undefined` in `prior` (a public route that skips `Authenticate` is still limited by
  `input.ip`). A route that runs a guard before one it lists, or skips one a kept guard lists in `after`, fails the
  boot (`guard-order`, also a `murmur check` error). Never request a guard from a serve method
  (`guard-requested-directly`): put it on the route.
- `meta` is a zod shape the routes fill: `Guard(Scope, { meta: { role: Role.default('viewer') } })` and
  `web.patch('/items/:id', { meta: { role: 'member' } })`; the guard reads `input.meta.role` typed, defaults applied.
  A key no kept guard reads fails the boot naming the accepted keys (`guard-meta-unknown`).
- Each guard is one bus request; a guard answered in this process is dispatched in-process (same run context, policy
  and `$sys` events, no transport hop).
- A refusal is an acked delivery: the trace shows `rejected 401`, nothing is dead-lettered, the method never ran. A
  guard that _throws_ is broken: retried, dead-lettered, 502.

## Idempotent routes

Client retries of a create are one route option, never app code:
`web.post('/orders', { status: 201, idempotent: { scope: ['auth.actor.id', 'ip'], ttlMs?: 86_400_000, header?: 'idempotency-key' } })`.

- No `Idempotency-Key` header: the method runs plainly. A key that is not 1–255 printable ASCII fails as the `headers`
  input part. The scope is the first listed path (`auth.*`, `ip`, `peer`) with a value, so an anonymous create scopes by
  IP; with none the method runs plainly.
- One `BEGIN IMMEDIATE` claim on the app database (`murmur_idempotency`; the http capability needs sqlite then): a new
  key runs the method; a key still running answers `errors.idempotency.inProgress` (default 409 `conflict`) until the
  piece timeout, then the next retry takes it over (a crashed first request); a finished key with another request (sha256
  of the route, path, sorted query and canonical JSON body) answers `errors.idempotency.reused` (default 422
  `invalid_input`); the same request replays the stored status, method headers and body plus `Idempotent-Replayed: true`, with fresh `responseHeaders` and
  trace headers.
- A 2xx answer is kept for `ttlMs`; any other status or a throw keeps no row, so the client may retry. A 2xx larger
  than `maxBodyBytes` or a `text/event-stream` is answered but not kept (a retry runs again). Expired rows are deleted on the next claim. `idempotent` on GET or a raw route fails the boot
  (`idempotent-method`), a scope path the route's guards do not produce too (`idempotent-scope`), both also
  `murmur check` errors.

## Families, conflicts, shadowing

An edge owns route **families** (first static segment: `/todos…`, `/stats`). `GET /todos/search` goes in the piece that
already serves `/todos` (`murmur catalog` ROUTES shows it); a new family goes into the existing edge unless it has its
own lifetime or failure mode (the SSE feed owns `/events`). At one depth a static segment beats `:param`, which beats
`/*rest`.

- `binding-conflict` (boot error, check error): equal keys after normalising params (`/todos/:id` vs `/todos/:slug`,
  `*` vs a verb, `/*rest` over `:bucket`), naming both pieces.
- `route-shadowed` (error): a static route in one piece under another piece's `:param` (`/todos/events` next to
  `/todos/:id`).
- `route-family-split` (warning): two pieces serve one family on one transport.

## Streaming, SSE, raw

Any method may return `new Response(readableStream, { headers })`; the adapter pipes it without buffering. SSE is that
with `content-type: text/event-stream`: keep a `Set` of stream controllers on the piece, add one in `start`, remove it
on `req.signal` abort, fan events out from `@Handle` methods and wrap `enqueue` in `try/catch` (a cancelled stream
throws between the disconnect and the abort listener). The ingress entry ends when the method returns the `Response`:
`$sys.ingress.completed` arrives right then and the stream outlives it, so nothing on the bus marks the client leaving
(the abort listener is the only signal). Clients are per process: with several processes each event reaches one
process's clients (a piece is a competing-consumer group). `web.raw('POST', '/uploads/:bucket')` gives an
unread `req.raw.body`, no limit, no coercion, and must return a `Response`.

## Testing an edge

```ts
await using t = await testPiece(RestApi, { auth: { userId: 'ada', roles: [], remaining: 9 } });
t.respond(GetTodo, (input) => ({ id: input.id, title: 'milk', done: false }));
const response = await t.fetch(new Request('http://app/todos/t1'));
```

`t.fetch` runs the matching binding of this piece only, with `auth` of your choice and no guards; shorthands forward
to `t.respond`ers. Admission (guards, `meta`, 401/429, idempotent replays) is tested on the whole app:
`await using app = await createTestApp()` from `@murmur/node/testing` boots every piece over real HTTP on a temp
migrated sqlite file (port 0, overridable clock, job polling off): `await app.fetch('/todos/t1')`, `app.db`,
`await app.clock.freeze(instant)`, `await app.jobs.drain()`, `await app.reset()` (app rows, jobs, idempotency rows,
kv counters and once markers, clock override).

## In the trace

An HTTP request is one trace whose root is the ingress entry, `$ingress.http` with `{ method, path, binding }`; the
guard requests are its first children, then whatever the method requested:

```
$ingress.http  (http)   0–2ms  {"method":"GET","path":"/todos/t1","binding":"GET /todos/:id"}
├─ auth.Authenticate
│  ├─ auth              attempt 1  acked 1ms
│  └─ reply → api/rest  rejected 401 (1ms)
```

`$sys.ingress.received/completed/failed { piece, transport, binding, traceId }` record each entry (`murmur tail
--internal`); `received` carries the `$ingress.http` envelope the trace roots on.
