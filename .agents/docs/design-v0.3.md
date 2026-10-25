# murmur v0.3 design: the request pipeline and the durable lane

> Status: design, 2026-10-25; shipped as 0.3.0 (frozen). `spec.md` specifies the shipped surface and §9 lists where the implementation departs from this text. Builds on V11a (the pilot-1 runtime fixes, `decisions.md` 2026-10-25: sqlite busy timeout/WAL/BEGIN IMMEDIATE + migration re-check, `murmur start` pid = runtime, ingress only where an edge is served or `enabled: false`, piece-served `/healthz`, `req.peer`/`req.ip` + `trustProxy`, `runInContext`, 404 envelope from the token). Everything here is stated for the app class **HTTP API + background workers + one SQL database, several processes**; the evidence product is only an instance. Milestones V11b–V11k in §6. Read §0–§2 and §6 for the fifteen-minute version; §3 is the reference the implementers work from.

## 0. One paragraph

Estimates here predate measurement; measured figures are in `docs/research/results.md`. Two agent teams built the same product on murmur and on NestJS. In the murmur app 94% of edge lines and about 30% of non-edge lines are one request pipeline and one durable-work stack that every piece rebuilt by hand, because murmur's pipeline stops at parallel header-only guards and `req.input`, and the bus has nothing durable across processes. v0.3 adds ten mechanisms, no new decorators and no new `this.*` member: sequential guards with route `meta`, one `req.read` and one `req.reply`, `Rejection` as a legal output, an `idempotent` route option, a `jobs` capability on the app database, a freezable clock and a kv counter, callback transactions plus `murmur migrate`, named processes, auto-faked tests and `createTestApp`, and a pure `lib/` lane with `Paging`/`Page`/cursor. Edges drop from ~71 to ~13 LOC per route (the NestJS controller figure), the app loses ~6k of ~14.6k source lines and ~2.9k of test lines, and what stays app-side is the product's permission model, its schemas, its row mappers and its domain skeletons. On the owner's question: with this landed, a second pilot of the same app class should spend its framework friction on the next tier (broadcast subscriptions, outbound signed delivery logs, multipart, CORS, exotic zod issue codes), not on the eleven blocks below. Fewer and different issues, not none.

## 1. Problem: what both teams rebuilt

Measured in the murmur evidence app (24 pieces, 6 public edges, 50 routes, ~14.6k source LOC) and cross-checked against the NestJS app (9,466 LOC, ~4.5k of it infrastructure). "Owner" is where the block should live after v0.3.

| # | Pattern (generic) | Where seen | Occurrences | LOC | Owner after v0.3 |
|---|---|---|---|---|---|
| 1 | Admission ladder per route: parse id → authenticate → resolve target chain → deleted/gone → role rank → 403, with a dead `actor === null` branch that drifted 401/500/throw | every edge; Nest: one AccessGuard | 50 routes, 6 copies | 596 (Nest 339) | Framework: ordering, meta, typing, headers. App: one guard piece |
| 2 | Idempotency-Key protocol: begin/replay/in-progress/key-reused/complete/abort, fingerprint, stored response, TTL sweep | 6 drifting edge copies + a domain piece; Nest: interceptor with 2 defects | 8 routes | 505 + 147 (Nest 273) | Framework |
| 3 | JSON body preamble: 415/413/400/422 split, typed extraction, hand-written validator with per-field detail codes | 7 copies of readJson, kit `validate` 712 LOC; Nest validate 362 | 16 handlers | 330 + 712 (Nest 478) | Framework (read, order, failure map). App: schemas |
| 4 | Transport preamble: If-Match parse, Idempotency-Key format, positive-int path id, peer | every edge | 50 | 375 | Framework |
| 5 | Query allowlist + typed readers, duplicate detection | every edge | 50 | 373 | Framework. App: schema |
| 6 | Response tail: `ok ? versioned(...) : refused(...)`, null → 404, ETag, rate headers via 6 mechanisms, 5 not-found texts, pagination x6 | every handler | 49 | 464 | Framework |
| 7 | Access log wrapper with drifting field names | every edge | 50 | 118 | Framework |
| 8 | Outcome union by hand (`outcome()`, `ok()`, `fail()`, per-piece failure factories, version-conflict detail x5) | contracts + every domain piece | 43 wrappers | 160 | Framework |
| 9 | Job runner: poll, claim, retry ladder, dead, group FIFO, stale recovery, drain; periodic trigger; transactional fan-out ("ledger") | worker + ledger capability; Nest jobs 593 + outbox 854 | 5 job kinds | 619 + 652 + 95 | Framework: queue, retry, schedule, enqueue-in-tx. App: handlers |
| 10 | Shared test clock in a DB table; in-memory rate counters (wrong with >1 API process) | time capability; gate piece; Nest clock + throttler | 23 pieces | 253 + 58 (Nest 96 + 66) | Framework |
| 11 | Pure helpers disguised as a capability (`kit`), two byte-identical paging files, duplicated row mappers, 1,800 lines of test preamble with 36 pasted CREATE TABLEs, process roles via shell scripts, app db + proxy capabilities | whole app | 20 pieces, 17 tests | 2,068 + 450 + 500 + 1,800 + 620 + 501 | Framework: `lib/` lane, fakes, `createTestApp`, processes, V11a |

Verified at framework HEAD: guards run in parallel (`http/guards.ts`, `Promise.allSettled`); `GuardInput` is `{ transport, operation, headers, params }`; `Rejection.details` is a record and has no `headers`; `RouteOptions` is `{ status, guards, skip, timeoutMs, maxBodyBytes }`; the body is buffered before `host.invoke` and therefore before guards; a nested transaction throws while an internal `Database.transaction(holder, work)` callback already exists; `kv` has no `incr`; `@Handle` has one option slot (`batch`, rejected at boot); `this.clock`, `this.ids`, `this.emit`, Event contracts and http guards were used **zero** times in the evidence app.

## 2. Principles

**The framework owns** the shape of every request and every unit of durable work: admission order and typing, input reading and the failure map, outcome rendering, idempotency, the job queue and schedule leases, time and counters shared across processes, transactions and migrations, process topology, test provisioning. All of it is generic to the app class and was rebuilt by both teams.

**Apps own** the decisions: who may do what (the guard piece), which fields exist (zod schemas), how SQL rows become models (mappers, with a narrow decoder for 0/1 and JSON text), what "stale", "gone" and "conflict" mean per entity, every product rule.

**Forbidden after v0.3** (replaced outright, no compatibility): `req.input(C)`; `req.json/text/formData` on non-raw routes; parallel guards; a body buffered before admission; `@Handle(C, { batch })`; the `await using tx` transaction form; `murmur start --only`; "shared conventions live in an app capability" (replaced by `lib/`); a request to a guard from a serve method; a piece that writes a table another piece's `schema.sql` created (warning); a request or event that would cross a process boundary on the memory transport (error / warning).

**Kept constraints**: `class X extends Piece({...})` with `@Handle`/`@Serve`; edges explicit (no verb sugar, no parameter decorators, no decorator-on-binding); guards `return reject()`; capabilities the only way out; CLI the only agent surface; minimal default brief; core zero runtime deps; bus swappable (the durable lane is the SQL database, the bus is untouched); no agent comments; don't overthink. **One constraint bends** and is recorded here as an owner decision (§7.1): "edges own status codes" becomes "edges own transport; a domain handler may return `reject(status, ...)` as a business refusal and the edge renders it unchanged".

**Every new check or lint message names the allowed form.** Writers who meet a wall get the door in the same sentence.

## 3. Design, mechanism by mechanism

Format per mechanism: finding removed · what a piece writer types · framework-side shape · check/lint · what `murmur ctx` shows (approximate tokens).

### 3.1 Admission: sequential guards with route `meta`

**Removes** #1 (596 LOC), #7 (118), the rate-header half of #6, the in-memory counters of #10. Both teams set `guards: []` because guards ran in parallel on headers only, could not see a target or a required role, could not carry `Retry-After`, and ran after the 413 check.

**Writer types** (guard contracts, once per app):

```ts
// contracts/access.ts
export class Principal extends Model({ actor: Actor.schema, keyId: z.string() }) {}
export class Authenticate extends Guard(Principal) {}

export class Scope extends Model({ role: Role, target: Target.schema }) {}
export class ResolveTarget extends Guard(Scope, {
  after: [Authenticate],
  meta: { target: TargetKind, param: z.string().default('id'), role: Role.default('viewer'), allowDeleted: z.boolean().default(false) },
}) {}

export class Rate extends Model({ rate: RateInfo.schema }) {}
export class RateLimit extends Guard(Rate, { optional: [Authenticate, ResolveTarget] }) {}
```

The guard piece, once per app (this is the product's permission model, so it stays app code, written once instead of six times):

```ts
// pieces/app/access/piece.ts
export class Access extends Piece({ needs: { db: sqlite, kv } }) {
  @Handle(Authenticate)
  async authenticate(input: Authenticate): Promise<Principal | Rejection> {
    const secret = bearer(input.headers['authorization']);
    const row = secret === null ? undefined : await this.db.get<KeyRow>(FIND_KEY, sha256(secret));
    if (row === undefined) {
      return reject(401, 'Missing, malformed or unknown credential.');
    }

    return { actor: actorOf(row), keyId: row.id };
  }

  @Handle(ResolveTarget)
  async resolve(input: ResolveTarget): Promise<Scope | Rejection> {
    const id = positiveInt(input.params[input.meta.param]);
    const chain = id === null ? null : await loadChain(this.db, input.meta.target, id);
    const role = chain === null ? null : await roleOf(this.db, chain.tenantId, input.prior.actor.id);
    if (chain === null || role === null) {
      return reject(404, 'The object was not found.');
    }

    if (chain.deletedParent || (chain.deleted && !input.meta.allowDeleted)) {
      return reject(410, 'The object has been deleted.', { code: 'gone' });
    }

    if (!meetsRole(role, input.meta.role)) {
      return reject(403, 'Your role does not allow this action.');
    }

    return { role, target: chain.target };
  }

  @Handle(RateLimit)
  async limit(input: RateLimit): Promise<Rate | Rejection> {
    const bucket = bucketFor(input.ip, input.prior.actor, input.prior.role);
    const { count, resetAt } = await this.kv.incr(bucket.key, { windowMs: bucket.windowMs });
    if (count > bucket.limit) {
      return reject(429, 'Too many requests.', { headers: { 'retry-after': secondsUntil(resetAt, this.clock.now()) } });
    }

    return { rate: { limit: bucket.limit, remaining: bucket.limit - count, reset: resetAt } };
  }
}
```

Routes carry only `meta`:

```ts
@Serve(web.patch('/v1/items/:id', { meta: { target: 'item', role: 'member' } }))
@Serve(web.post('/v1/items/:id/restore', { meta: { target: 'item', role: 'member', allowDeleted: true } }))
@Serve(web.post('/v1/accounts', { skip: [Authenticate, ResolveTarget], idempotent: { scope: ['ip'] } }))
```

**Framework shape**

- `Guard(Output, { after?, optional?, meta? })`. `after` names guards that must have run and whose outputs are in `prior`, typed as their intersection. `optional` names guards that run before this one when the route keeps them, typed `| undefined` in `prior`. This resolves the anonymous-route case the critic raised: a public signup route can `skip: [Authenticate]` and still be rate limited by IP, while `ResolveTarget` keeps a non-nullable `prior.actor`, so the dead `actor === null` branch cannot be written. `meta` is a zod shape; the route's `meta` literal is parsed through the union of the kept guards' shapes with defaults applied, so the handler reads `input.meta.target` typed, never `String(input.meta['target'])`.
- `GuardInput` becomes `{ transport, operation, headers, params, peer, ip, meta, prior }`. `peer`/`ip` come from V11a's request fields.
- Guards run in declaration order (the token's list, then route extras), one at a time. The first `Rejection` answers. Outputs merge onto `req.auth` as today; `AuthOf` is unchanged.
- `Rejection` gains `headers?: Record<string, string>`. The renderer applies `headers` from guard rejections (the 429 `Retry-After` case). A `Rejection` returned by a domain handler may carry `headers` on the wire, but the edge ignores them: HTTP headers are an edge concern and the edge adds them through `req.reply` (§3.2).
- The body is buffered **after** admission and only when the handler reads it (`req.read` with `body`, or an `idempotent` route, which needs the fingerprint). Content-length is still pre-checked against `maxBodyBytes` so an oversize upload is refused with 413 without buffering, but only after the guards answered. Precedence by construction: 429/401/404/410/403, then 413/415/400/422.
- **In-process shortcut** ships in the same milestone: a request whose contract has a handler in this process is dispatched locally with the same run context, policy and `$sys` events, and no transport hop. Three guards per request on AMQP would otherwise cost three round trips before the handler.
- Token options: `responseHeaders(auth: Partial<Auth>) => Record<string, string>` applied to every response after admission passed (success, error, replay) and `log(auth) => Record<string, unknown>` merged into the built-in access log line `{ method, path, status, ms, traceId, ...log(auth) }` emitted once per ingress entry. Two callbacks on the token, both app-owned, because 50/50 routes needed both and six mechanisms did it in the evidence.

**Check / lint**

| Finding | Kind | Message names the allowed form |
|---|---|---|
| `guard-order` | error | "route X: Y runs before Z, which Y lists in `after`; reorder the token's guards, or make Z `optional` on Y" |
| `guard-order` (skip) | error | "route X skips Z but keeps Y, whose `after` names Z; skip Y too, or declare Z in Y's `optional`" |
| `guard-meta-unknown` | error | "route X: meta key `rol` is read by no kept guard; the kept guards accept target, param, role, allowDeleted" (also a boot error) |
| `guard-requested-directly` | warning | "`this.request(ResolveTarget)` in a serve method; admission belongs on the route: `web.get(path, { guards: [ResolveTarget] })`" |

**ctx** — Serves sheet gains an "Admission" block before the route table: the ordered guard list with `after`/`optional`, each guard's `meta` keys and defaults, the per-route auth type, whether `responseHeaders`/`log` are set (~250 tokens). The guard piece's Contracts section prints the `Guard(...)` statement plus a fixed five-line "Guard input" note: `headers, params, peer, ip, meta, prior`; `return reject(status, message, { code, details, headers })` (~120). The http docs page's "guards run in parallel" bullet becomes "guards run in order; the body is read after them".

### 3.2 Edge I/O: `req.read` and `req.reply`

**Removes** #3 (330 + the 712-LOC validator), #4 (375), #5 (373), the rest of #6 (464). `req.input` could not be used: it ignored a wrong media type, gave malformed JSON and schema failure the same 400, had no stable per-field codes, merged params/query/body into one contract input that could never be the domain contract, and ran before admission.

**Writer types**

```ts
@Serve(web.post('/v1/containers/:id/items', { status: 201, meta: { target: 'container', role: 'member' }, idempotent: { scope: ['auth.actor.id'] } }))
async create(req: WebRequest): Promise<HttpResult> {
  const { body } = await req.read({ body: ItemCreate });
  const out = await this.request(CreateItem, { actor: req.auth.actor, containerId: req.auth.target.id, ...body });

  return req.reply(out, { etag: (item) => item.version });
}

@Serve(web.get('/v1/containers/:id/items', { meta: { target: 'container' } }))
async list(req: WebRequest): Promise<HttpResult> {
  const { query } = await req.read({ query: ItemFilter });
  if (query.include_deleted && !isAdmin(req.auth.role)) {
    return reject(403, 'Only admins may list deleted items.');
  }

  return this.request(ListItems, { containerId: req.auth.target.id, ...query });
}

@Serve(web.patch('/v1/items/:id', { meta: { target: 'item', role: 'member' } }))
async update(req: WebRequest): Promise<HttpResult> {
  const { body, headers } = await req.read({ body: ItemPatch, headers: { 'if-match': IfMatch } });
  const out = await this.request(UpdateItem, { actor: req.auth.actor, id: req.auth.target.id, ifMatch: headers['if-match'], ...body });

  return req.reply(out, { etag: (item) => item.version });
}

@Serve(web.delete('/v1/items/:id', { status: 204, meta: { target: 'item', role: 'member' } }))
async remove(req: WebRequest): Promise<HttpResult> {
  const { headers } = await req.read({ headers: { 'if-match': IfMatch } });

  return this.request(DeleteItem, { actor: req.auth.actor, id: req.auth.target.id, ifMatch: headers['if-match'] });
}
```

The token declares the failure map once:

```ts
const web = http({
  guards: [Authenticate, ResolveTarget, RateLimit],
  maxBodyBytes: 64 * 1024,
  errors: {
    envelope: ({ code, message, issues, details }) => ({ error: { code, message, details: details ?? issues } }),
    input: {
      body: { status: 422, code: 'validation_failed' },
      query: { status: 400, code: 'invalid_query' },
      headers: { status: 400, code: 'invalid_header' },
      params: { status: 404, code: 'not_found' },
      json: { status: 400, code: 'malformed_json' },
      mediaType: { status: 415, code: 'unsupported_media_type' },
    },
    idempotency: { inProgress: { status: 409, code: 'in_progress' }, reused: { status: 422, code: 'key_reused' } },
  },
  responseHeaders: (auth) => rateHeaders(auth.rate),
  log: (auth) => ({ actor: auth.actor?.id ?? null }),
});
```

**Framework shape**

- `req.read({ params?, query?, headers?, body? })`: each part a zod object or shape. Parts are read in that order; the first failing part answers with `errors.input[part]` (defaults: params 404 `not_found`, query/headers/json 400 `invalid_input`, mediaType 415 `unsupported_media_type`, body 400 `invalid_input`). The return type is the parsed parts, no casts.
  - `params`: strings from the router; a schema like `{ id: z.coerce.number().int().positive() }` gives a typed id and a 404 on garbage after admission.
  - `query`: strict. Unknown keys and repeated single-valued keys fail; `z.array()` fields accept repeats; values coerced from strings (existing `coerce.ts`).
  - `headers`: keys lower-case; a missing header with an optional/nullable schema is `null`.
  - `body`: POST/PUT/PATCH/DELETE only; empty body is `{}`; non-JSON media type fails as `mediaType`; invalid JSON as `json`; a non-object body as `body` with one root issue (`path: []`).
  - Issues keep zod's `code` and params (`minimum`, `maximum`, `keys`, `values`, `format`) as `issues: [{ path, code, message, ...params }]`. `errors.input.issueCodes?: Record<string, string>` renames codes (`too_small` → `too_short`), the escape for specs with their own detail vocabulary. The envelope receives `{ status, code, message, issues?, details?, cause? }` and decides where issues land. The sample above puts them in `details`. Refinements with explicit `params` cover codes zod cannot distinguish; the Serves sheet says so and shows one rendered 422 body.
- `req.reply(outcome, { status?, headers?, etag? })`: the one response tail. `outcome` is `Output | Rejection | null | undefined`. `Rejection` renders through the envelope with its status/code/details; `null` is 404 (envelope from the token); `undefined` is 204; a plain object is JSON with `status ?? route.status`. `etag` is a string or `(body) => string | number`, rendered as a strong ETag; on GET/HEAD a matching `If-None-Match` answers 304. `headers` are added as given. `responseHeaders(auth)` and trace headers are applied centrally after. A serve method may also return the outcome directly (`return this.request(...)`); `req.reply` exists for headers and etag. The return type of a serve method is `HttpResult = Response | object | Rejection | null | undefined`.
- Exported from `murmur`: `IfMatch` (zod: quoted strong ETag → inner string, `*` allowed, `null` when absent) and `etag(value)`. Exported from `@murmur/node/lib`: `bearer(header) => string | null`, `canonicalJson`, `sha256`, `cursor` (§3.10).
- Removed: `req.input`, `req.json/text/formData` on non-raw request types (raw routes keep the stream and `Request` methods), the `ContractViolationError → 400 invalid_input` body path.

**Check / lint** — none new. `req.input` disappears from the types; `tsc` does the rest.

**ctx** — Serves sheet: the three `SERVE_RULES` bullets become "read with `req.read({...})` (part order, strict query, media type)", "answer with `req.reply(outcome, { status, headers, etag })` or return the outcome", "a `Rejection` renders unchanged; `null` 404; `undefined` 204", plus an "Input failures" table from the token (part → status/code, issueCodes if any) and one rendered 422 example (~220 tokens). Rule 7 is rewritten (§3.11).

### 3.3 `Rejection` as an output of any Query or Command

**Removes** #8 (160 LOC, 43 `outcome()` wrappers, the per-piece `notFound/gone/stale` factories, the version-conflict detail rebuilt five times) and the `ok ? … : …` half of #6. Today the pipeline reads a `Rejection` only in guard replies; a domain error thrown is always 502 at the edge.

**Writer types**

```ts
// contracts/items.ts
export class UpdateItem extends Command({ actor: Actor.schema, id: Id, ifMatch: IfMatch, ...ItemPatchFields }, rejectable(Item)) {}
export class DeleteItem extends Command({ actor: Actor.schema, id: Id, ifMatch: IfMatch }, rejectable(Empty)) {}

// pieces/app/items/piece.ts
@Handle(UpdateItem)
async update(input: UpdateItem): Promise<Item | Rejection> {
  return this.db.transaction(async (tx) => {
    const row = await tx.get<ItemRow>(SELECT_ITEM, input.id);
    if (row === undefined) {
      return reject(404, 'The object was not found.');
    }

    if (input.ifMatch !== null && input.ifMatch !== String(row.version)) {
      return reject(409, 'The object changed since you read it.', {
        code: 'version_conflict',
        details: [{ path: 'if-match', code: 'stale', current: row.version }],
      });
    }

    const next = applyPatch(row, input, this.clock.now());
    await tx.run(UPDATE_ITEM, ...values(next));
    await this.jobs.enqueue(FanOutChange, { kind: 'item.updated', id: row.id, version: next.version });

    return toItem(next);
  });
}
```

**Framework shape**

- `rejectable(M)` returns `z.union([M.schema, Rejection.schema])` tagged so the Contracts sheet and catalog print `rejectable(Item)`. `OutputOf` is `Item | Rejection`; `isRejection(v)` narrows. Explicit, not implicit: every refusing contract is visible in `murmur catalog` (§7.2).
- `Rejection.details` widens to `Record<string, unknown> | Record<string, unknown>[]`.
- Bus semantics, stated in the rules text: a returned `Rejection` is a **successful delivery**. No retry, no dead-letter, the reply is sent normally, a Query returning a Rejection is still deduplicated per trace. A throw keeps today's meaning: the operation did not happen, retry then dead-letter.
- The edge renders a `Rejection` outcome through the envelope in both the method form (via `req.reply` or a direct return) and the class shorthand `@Serve(binding, C)`.
- The method form's `ExactRequest`/return typing accepts `HttpResult`.

**Check / lint** — `contracts-json-faithful` accepts `rejectable()` and `Page()`.

**ctx** — rules 5 and 7 rewritten (§3.11); Contracts section renders `rejectable(Item)`; one Serves bullet "returning: output, Rejection, Response, undefined (204), null (404)" (~80 tokens).

### 3.4 Idempotent routes

**Removes** #2 (505 edge + 147 domain LOC, six implementations that drifted on fingerprint, stored headers and the dead branch; the NestJS version parsed the body twice and left keys stuck at 409 after a crash).

**Writer types** — one route option: `idempotent: { scope: ['auth.actor.id', 'ip'], ttlMs?: 86_400_000, header?: 'idempotency-key' }`. `scope` is a list of dotted paths into `req` (`auth.*`, `ip`, `peer`); the first that resolves to a non-null value is the scope, so anonymous creates scope by IP and authenticated ones by actor.

**Framework shape**

- Header absent: the handler runs plainly. Header present but not 1–255 printable ASCII: fails as the `headers` input part.
- Fingerprint = sha256(route key + canonical JSON of the body). The body is buffered once, after admission; `req.read` reuses the buffer.
- In one `BEGIN IMMEDIATE` transaction on the app database: no row → insert `running` with `locked_until = now + route timeout`; `running` row → `errors.idempotency.inProgress` (default 409 `conflict`); completed row with another fingerprint → `errors.idempotency.reused` (default 422 `invalid_input`); completed row with the same fingerprint → replay. A `running` row past `locked_until` is reclaimed (the crash defect closed).
- Replay sends the stored status, the handler-set headers and body, plus `Idempotent-Replayed: true`, then fresh `responseHeaders(auth)` and trace headers (recomputed, never stored). That answers the "what exactly is stored" question the evidence drifted on.
- A 2xx result is stored (status, handler headers, body up to `maxBodyBytes`) and the row completed; any other status or a throw deletes the row. Expired rows are swept on insert (`DELETE ... WHERE expires_at < ?`), no scheduler.
- Table `murmur_idempotency(scope, key, route, fingerprint, state, status, headers, body, locked_until, expires_at)`; the http capability gains `needs: ['sqlite']` when any route is idempotent. All timestamps from the runtime clock (§3.6).

**Check / lint**

| Finding | Kind | Message |
|---|---|---|
| `idempotent-method` | error | "route GET /x: `idempotent` applies to POST/PUT/PATCH/DELETE on non-raw routes; drop it or change the method" |
| `idempotent-scope` | error | "route X: scope `auth.acter.id` does not resolve against this route's auth type; available: auth.actor.id, auth.keyId, ip, peer" |

**ctx** — route table gains an `idempotent` column (scope, ttl); one bullet on the protocol (~60 tokens). Rule 6 rewritten.

### 3.5 Jobs: durable commands on the app database

**Removes** #9 (runner 326, periodic trigger 95, the outbox half of the ledger ~150, five identical `Run*Job` contracts; NestJS jobs 593 + scheduler tick 85 + the dedupe-null hack).

**Writer types**

```ts
import { jobs, sqlite } from '@murmur/node/capabilities';

export class Notifier extends Piece({ needs: { db: sqlite, jobs, fetch } }) {
  @Handle(FanOutChange)
  async fanOut(input: FanOutChange): Promise<void> {
    for (const endpoint of await this.db.rows(Endpoint, SUBSCRIBED, input.kind)) {
      await this.jobs.enqueue(Deliver, { endpointId: endpoint.id, ...input }, { groupKey: `endpoint:${endpoint.id}` });
    }
  }

  @Handle(Deliver, { retry: { attempts: 6, after: ['30s', '2m', '10m', '1h', '6h'] } })
  async deliver(input: Deliver, delivery: Delivery): Promise<void> {
    const response = await this.fetch(input.url, { method: 'POST', body: sign(input), signal: delivery.signal });
    if (!response.ok) {
      throw new Error(`endpoint answered ${response.status}`);
    }
  }

  @Handle(SweepDue, { every: '1m' })
  async sweep(): Promise<void> {
    for (const row of await this.db.rows(DueRow, DUE, this.clock.now().toString())) {
      await this.jobs.enqueue(Notify, { id: row.id }, { dedupeKey: `notify:${row.id}:${row.dueAt}` });
    }
  }
}
```

**Framework shape**

- `jobs.enqueue(C, input, { runAt?, dedupeKey?, groupKey? })`: `C` is a Command; input validated against `C.input`; row in `murmur_jobs`. Inside `db.transaction(fn)` of the same delivery the insert joins that transaction, so the job exists if and only if the business write commits: the transactional outbox both teams hand-built. `dedupeKey` is `INSERT OR IGNORE` on a unique index over **pending** rows only, so a running job may re-enqueue itself with the same key (the NestJS trap avoided).
- Runner: each process polls (`pollMs` default 500) and claims with `UPDATE ... RETURNING` only jobs whose contract is handled by a piece loaded in that process. It learns that through a narrow runtime port, `ingress.invokeLocal(contractName, input, { attempt, signal })` plus `ingress.handles(contractName)`; the capability never holds piece instances. `invokeLocal` runs the handler like an HTTP entry: run context, `$sys` events, piece timeout. `groupKey` is FIFO with one running job per group. Concurrency per process is capability config (default 8); a process entry in `processes` may set `jobs: false` so API processes do not claim.
- Retry: a throw reschedules by the handler's `retry` option when present, else the piece's `policy.retry`, up to `attempts`, then `dead`. `after` is a ladder of durations used in order (the last repeats). `NonRetryableError` is dead at once. `locked_until` reclaims stale running rows after the piece timeout. `delivery.attempt` is the job attempt; `delivery.envelope.id` is stable per job so `kv.once` works unchanged.
- `@Handle(C, { every: '<n>(s|m|h|d)' })`: `C` must be a Command with no required input fields. A lease row in `murmur_schedules` is claimed atomically by whichever process ticks first and the job is enqueued with `dedupeKey = '<name>@<due>'`, so it runs once across all processes. No cron in this version. `{ batch: true }` is removed; `every` and `retry` are the Handle options.
- Stop: the runner stops claiming, waits for in-flight jobs up to the piece timeout and releases unfinished claims. The jobs capability declares `ingress: true`, and the runtime's stop sequence gives ingress capabilities the drain budget (piece timeout), not the 2 s capability budget. Written in the jobs docs page.
- Test mode (`capabilities.jobs.poll: false`): `jobs.drain()` runs every job due by the current clock, schedules included, until none is left and returns `{ ran, failed, dead }`; `jobs.counts()` gives per-state counts. `drain()` is documented as process-local; `createTestApp` hosts all pieces by default so one drain covers API and worker handlers.
- `murmur tail` shows job deliveries like any other (kind `job`); `$sys.job.claimed/succeeded/failed/dead` events exist. A `murmur jobs` CLI is deferred (§7.5).

**Check / lint**

| Finding | Kind | Message |
|---|---|---|
| `every-input` | error | "`@Handle(SweepDue, { every })`: SweepDue has required input fields; a scheduled command takes none" |
| `every-format` | error | "`every: '90'` is not a duration; use `<n>s`, `<n>m`, `<n>h` or `<n>d`" |
| `retry-ladder` | error | "`retry.after` entries must be durations like '30s'" |

**ctx** — jobs docs page in the Capabilities section (enqueue and its options, join-the-transaction, retry resolution, `every`, stop, drain/counts; ~350 tokens); header lanes gain `schedules: SweepDue every 1m`; Catalog rows of kind `job`.

### 3.6 Clock and counters

**Removes** #10 (253 + 58 LOC; `this.clock` unused in 23 pieces; counters wrong with more than one API process).

**Writer types** — `this.clock.now()` as today. In test mode: `this.clock.freeze(instant)`, `advance(ms)`, `clear()`. Rate guard: `this.kv.incr(key, { windowMs }) → { count, resetAt }`.

**Framework shape**

- `capabilities.clock.overridable: true` (yaml, meant for test environments): `now()` returns the frozen instant from `murmur_clock` when set, read once per run context. `freeze/advance/clear` throw unless overridable. The loader warns when it is true in prod mode. `testPiece`'s `now` and `t.clock` drive the same handle.
- **All framework time is the runtime clock**, overridable included: kv windows, schedule leases, `locked_until`, `expires_at`, `runAt`. One sentence in the defaults sheet.
- `kv.incr(key, { windowMs })`: one atomic fixed-window counter in `murmur_kv` (kind `counter`), window aligned to `floor(now / windowMs)`. Bucket selection and header rendering stay app code.
- `Temporal.Instant` stays the clock type; `toString()` is the ISO form apps store, `epochMilliseconds` the number form.

**ctx** — defaults sheet +4 lines (freeze/advance/clear, "all framework time is this clock"); kv docs +1 bullet (~60 tokens).

### 3.7 Database: callback transactions, one DDL source, narrow row decoding

**Removes** the repository/transaction ceremony (~200 LOC: 41 commit pairs, `Number(lastInsertRowid)`, `row ?? null`), the app db capability (368, V11a), the migrate script and e2e migration through capability internals, and about half of the row mapping (500 LOC: 27 Row types, 17 column strings, 15 mappers, one byte-identical duplicate).

**Writer types**

```ts
const id = await this.db.transaction(async (tx) => {
  const id = await tx.insert('items', { container_id: input.containerId, title: input.title, created_at: now });
  await this.jobs.enqueue(FanOutChange, { kind: 'item.created', id });

  return id;
});

const items = await this.db.rows(Item, SELECT_ITEMS, containerId);   // decodes done 0/1 -> boolean, labels TEXT -> string[]
const item = await this.db.row(Item, SELECT_ITEM, id);               // Item | null
```

**Framework shape**

- `db.transaction(fn)`: `BEGIN IMMEDIATE`, commit on return, rollback on throw; a nested call from the same delivery joins the outer transaction (the internal `Database.transaction(holder, work)` already does this). The `await using tx` form is removed. `kv.once`, `jobs.enqueue` and `db.*` calls of the same delivery join.
- `db.insert(table, row) → number | string` (lastInsertRowid or the given primary key).
- `db.rows(Model, sql, ...params)` / `db.row(Model, sql, ...params)`: decode columns by the Model's field types: integer → `z.boolean()`, TEXT → `z.array/z.object/z.record` via `JSON.parse`, everything else as is; column names must equal field names (alias in SQL). No column selection, no query builder, no relations. Computed fields stay app code. This is the judge's narrow graft; the critic's "ORM slope" objection is recorded in §7.4 with the line that must not be crossed.
- `murmur migrate` CLI and `migrate(root, env?)` export. **One DDL source**: `capabilities.sqlite.migrations` defaults to `pieces/**/schema.sql` plus `migrations/*.sql`; `murmur migrate`, boot and `fakeSqlite({ schema: 'app' })` run the same list; framework tables (`murmur_*`) are created by the capabilities that own them at start. Migration runs under `BEGIN IMMEDIATE` with the applied re-check from V11a, so `murmur start api` and `murmur start worker` booting together are safe. `path` accepts `sqlite:`/`file:` URLs and bare paths.
- Table ownership: "one owner per table" becomes "one **writer** per table". Reads across pieces are allowed and declared in context.md (the only option for worker pieces on one database).

**Check / lint**

| Finding | Kind | Message |
|---|---|---|
| `table-foreign-write` | warning | "pieces/worker/mailer writes `idempotency_records`, created by pieces/app/idempotency/schema.sql; move the write to its owner or make it a job that owner handles" |

The scan is a SQL-literal heuristic; that is why it is a warning, not an error.

**ctx** — sqlite docs page: the transaction bullets rewritten for the callback form, +1 bullet for `rows/row/insert`, +1 for migrations as the one DDL source (~130 tokens); header command line adds `murmur migrate`.

### 3.8 Processes

**Removes** the shell scripts and the relaunch/signal defects, the `$enabled` and `--only` second and third mechanisms, and the worker that started an ingress on an ephemeral port.

**Writer types**

```ts
// murmur.config.ts
export default defineApp({
  name: 'app',
  transport: () => createMemoryTransport(),
  capabilities: [sqlite, jobs],
  processes: {
    api: { pieces: ['api/**', 'app/**', ...(process.env.TEST_MODE === '1' ? ['test/**'] : [])], jobs: false },
    worker: { pieces: ['worker/**', 'app/**'] },
  },
});
```

`murmur start api`, `murmur start worker`; `murmur start` with no `processes` runs everything.

**Framework shape** — a piece not listed for the running process is not loaded: its routes are 404, its jobs are not claimed. Ingress starts only where a loaded piece serves (V11a). `murmur start --only` is removed; `murmur.config.ts` may read `process.env` (it already may), which covers the test-edge case without a yaml flag.

**Check / lint**

| Finding | Kind | Message |
|---|---|---|
| `request-crosses-process` | error (memory transport) | "api/items requests ListEndpoints, handled only in process `worker`; host the handler in `api` too, or make the work a job (`this.jobs.enqueue`)" |
| `event-crosses-process` | warning | "worker/notifier subscribes ItemCreated, emitted only in `api`; on the memory transport events stay in one process; use `this.jobs.enqueue` for cross-process work" |

**ctx** — header gains a `Process:` line (which processes host this piece; which requested contracts are reachable from each) (~40 tokens).

### 3.9 Tests

**Removes** 1,800 preamble lines in 17 piece tests (36 pasted `CREATE TABLE`s, 57 `kit:` wirings, 32 `fakeTime()`), the e2e boot through capability internals, the hand-kept table truncation list.

**Writer types**

```ts
await using t = await testPiece(Items);                 // db, jobs, clock, kv, fetch faked automatically
await t.deliver(CreateItem, { actor, containerId: 1, title: 'x' });
expect(t.enqueued(FanOutChange)).toHaveLength(1);

const app = await createTestApp({ env: { TEST_MODE: '1' } });  // all processes, temp migrated db
await app.reset();                                              // truncates app tables, clears clock override and jobs
app.clock.freeze('2026-01-01T00:00:00Z');
await app.fetch('/v1/items', { method: 'POST', ... });
await app.jobs.drain();
```

**Framework shape**

- `defineCapability({ ..., fake?: () => Handle })`. `testPiece(P)` provisions every declared need whose capability has a `fake` and that the test does not pass. Built-ins ship fakes: `sqlite → fakeSqlite({ schema: 'app' })`, `jobs → recorder` (`t.enqueued(C)`, and `t.runJobs()` to execute recorded jobs through the piece's handlers), `clock`, `kv`, `fetch`.
- `fakeSqlite({ schema: 'app' | 'own' | string[] })` applies the app's migration list (§3.7) or only the piece's `schema.sql`.
- `createTestApp({ processes?: 'all' | string[], env? })` from `@murmur/node/testing` returns `{ url, fetch, db, clock, jobs, reset, stop }` on a temp migrated database and runs the real pipeline including guards. `reset()` truncates every non-`murmur_*` table, clears the clock override, deletes jobs and idempotency rows.
- `t.fetch` for edges still skips guards and takes `auth`; the Tests hint says to use `createTestApp` for admission behaviour.
- `murmur test` includes `lib/**/*.test.ts`.

**ctx** — the Tests hint names `testPiece(P)` auto-fakes, `t.enqueued`, `fakeSqlite({ schema })`, `createTestApp` and its `reset/drain/freeze` (~100 tokens).

### 3.10 `lib/` lane, `Paging`/`Page`, cursor

**Removes** #11's helper capability (2,068 LOC with tests, ~840 tokens in 20 briefs), the byte-identical paging files, duplicated mappers and failure factories. The lint allowed only `#contracts`/`#capabilities` imports and the ingress doc said to put shared conventions in an app capability.

**Writer types** — `import { nfcTrim, fold } from '#lib/text';` from any piece, capability or test. `lib/text.ts` is a plain module.

```ts
export class ListItems extends Query({ containerId: Id, ...ItemFilterFields, ...Paging({ max: 100 }) }, Page(Item)) {}
```

**Framework shape**

- `#lib/*` maps to `./lib/*.ts` in the app template's `package.json` imports. A lib module may import `node:*` modules except those that do I/O or reach the network or process (`fs`, `net`, `http`, `https`, `http2`, `dns`, `tls`, `dgram`, `sqlite`, `child_process`, `worker_threads`, `cluster`, `os`, `process`, `vm`), `zod`, `murmur`, `@murmur/node/lib`, `#contracts/*` and other `#lib/*`. No top-level `let`, no `#capabilities`. `node:crypto` is allowed (hashing is pure; randomness is reachable, accepted).
- `murmur ctx lib/<module>` prints the module's exported signatures and tests; a piece brief's new "Lib" section lists the signatures of the lib modules the piece imports. `murmur test` runs lib tests. A lib module has no context.md: its signatures and tests are its source of truth.
- `Paging({ max?, default? })` → `{ limit, cursor: string | null }` with the app's bounds; `Page(Model, { cursorField?: 'next_cursor' })` → `{ data, <cursorField> }`. Neutral defaults (max 100, default 20, `next_cursor`), both parameterised.
- `cursor.encode(binding, position)` / `cursor.decode(binding, raw)` in `@murmur/node/lib`: base64url JSON with a checksum bound to a binding string (contract name + filter fingerprint); a bad cursor decodes to a `Rejection` 400 `invalid_cursor` the piece returns. The keyset predicate itself stays app code (§8).

**Check / lint**

| Finding | Kind | Message |
|---|---|---|
| `lib-pure` | error | "lib/mail.ts imports `node:fs`; lib modules are pure. Move the I/O to a capability (`capabilities/<name>/capability.ts`) and keep the formatting here" |
| `capability-looks-pure` | dropped | (heuristic misfires on thin wrappers; the rules text carries the guidance) |

`declared-deps-only` gains the `#lib/` alias. `folder-local-imports` is unchanged (lib is reached through `#lib`, never relatively).

**ctx** — Lib section (100–300 tokens when the piece imports lib modules, nothing otherwise); the defaults sheet gets one pointer to `cursor`, `bearer`, `canonicalJson`, `sha256`.

### 3.11 Rules text after v0.3

Rule 4 gains: "On the memory transport events stay in one process; cross-process durable work is `this.jobs.enqueue(Command, input)` inside the transaction."
Rule 5: "A business refusal is a returned `reject(status, message, { code, details })`: in a guard, or in any handler whose contract output is `rejectable(...)`. The edge renders it unchanged. `null` is not found. Throw only when the operation did not happen: it is retried, then dead-lettered; `NonRetryableError` when a retry cannot help."
Rule 6: "Client retries: `idempotent: { scope }` on the route. Bus redelivery: `this.kv.once(delivery.envelope.id, effect)` or a claim-first side table. Durable or delayed work: `this.jobs.enqueue(C, input, { runAt, dedupeKey, groupKey })`, never a timer; periodic work: `@Handle(C, { every: '1m' })`."
Rule 7: "Edges read with `const { params, query, headers, body } = await req.read({...})`, call one contract, and answer with `req.reply(outcome, { status, headers, etag })` or return the outcome. Admission is the route's guards and `meta`; never request a guard from a serve method. Domain pieces know no transport."
Rule 8 gains: "`this.db.transaction(async (tx) => ...)`; a nested call joins."
Rule 11 heuristic 2 becomes "one writer of each table; readers declare the table in context.md".
Rule 12 (new): "Shared pure code lives in `lib/` and is imported as `#lib/x`; a capability is I/O or state, never a helper bag."

Net effect on a brief: about +900 tokens of framework sheets on an edge, +450 on a domain or worker piece; minus the group `context.md` text that restated the hand-built pipeline (~1,700 tokens on every evidence edge) and the helper-capability page (~840 in 20 briefs). A lean app's brief grows by the framework share; all evidence briefs stay in the ok tier (6.2k–22.5k against 25k).

## 4. Example app migration: `examples/todo-api`

One edge, the guard piece and one domain piece. Line counts are non-blank.

### 4.1 Edge `pieces/api/rest/piece.ts` (43 → ~32 lines)

Before (today): `req.input(CreateTodo)`, `Response.json(todo, { status: 201, headers })`, a manual `if (todo === null) return req.error(404, ...)`, manual `If-None-Match` → 304, `this.log.info('todo created', ...)` for an access log, `etag.ts` helper.

After:

```ts
@Serve(web.get('/todos'), ListTodos)
@Serve(web.get('/todos/search'), SearchTodos)
@Serve(web.post('/todos/:id/complete'), CompleteTodo)
@Serve(web.delete('/todos/:id', { status: 204 }), RemoveTodo)
@Serve(web.get('/stats', { skip: [Authenticate] }), GetStats)
export class RestApi extends Piece() {
  @Serve(web.post('/todos', { status: 201, idempotent: { scope: ['auth.userId'] } }))
  async create(req: WebRequest): Promise<HttpResult> {
    const { body } = await req.read({ body: CreateTodo.input });
    const todo = await this.request(CreateTodo, body);

    return req.reply(todo, { headers: { location: `/todos/${todo.id}` }, etag: etagOf });
  }

  @Serve(web.get('/todos/:id'))
  async show(req: WebRequest): Promise<HttpResult> {
    const { params } = await req.read({ params: { id: z.string() } });

    return req.reply(await this.request(GetTodo, params), { etag: etagOf });
  }
}
```

The 304 branch, the 404 branch and the log line are gone; `etag.ts` stays (a hash of the model is app code). The token adds `log: (auth) => ({ user: auth.userId ?? null })`.

### 4.2 Guard piece `pieces/auth/piece.ts` (58 + `window.ts` 16 → ~44, `window.ts` deleted)

`RateLimit` becomes `Guard(Quota, { optional: [Authenticate] })` so `/stats` (which skips `Authenticate`) is still limited by IP. `bearerOf` is replaced by `bearer` from `@murmur/node/lib`; the sliding window class is replaced by `this.kv.incr(key, { windowMs: 60_000 })` (correct across processes); the 429 carries `headers: { 'retry-after': ... }`; the key is `input.prior.authenticate?.userId ?? input.ip`.

### 4.3 Domain piece `pieces/todos/*` (`piece.ts` 80, `repository.ts` 123 → ~70 + ~60)

Before: a `TodoRepository` class with a `private readonly db` constructor shell, `await using tx = await this.db.transaction()` + `tx.commit()`, a `todo_requests` claim table with an `announced` flag to make `CreateTodo` idempotent under redelivery and the emit at-most-once, `TodoRow` + `toTodo` mapping `done` 0/1.

After:

```ts
@Handle(CreateTodo)
async create(input: CreateTodo, delivery: Delivery): Promise<Todo> {
  const fresh = { id: this.ids.uuid(), title: input.title, created_at: this.clock.now().toString(), done: 0 };
  const { value } = await this.kv.once(delivery.envelope.id, async () => {
    await this.db.insert('todos', fresh);
    await this.emit(TodoCreated, { id: fresh.id, title: fresh.title });

    return fresh.id;
  });

  return (await this.db.row(Todo, `${SELECT} WHERE id = ?`, value)) ?? toTodo(fresh);
}

@Handle(GetTodo)
async get(input: GetTodo): Promise<Todo | null> {
  return this.db.row(Todo, `${SELECT} WHERE id = ?`, input.id);
}
```

`repository.ts` becomes a module of functions over `Sqlite` (`markDone`, `remove`, `search`), `TodoRow`/`toTodo` are replaced by `db.row(Todo, ...)`, the `todo_requests` table and its schema lines go. The e2e test (646 lines, spawns the CLI) boots with `createTestApp()` and uses `app.reset()` between cases; the piece tests drop their `fakeSqlite` + `readFileSync(schema.sql)` preambles.

This app is tiny, so its own saving is ~90 lines; it serves as the proof app for every milestone in §6. The evidence-scale arithmetic is §5.

## 5. Expected reduction

Edges (evidence: 6 public edge pieces, 50 routes, 3,545 non-blank LOC, 71 LOC/route):

| Category | Before | After | Mechanism |
|---|---|---|---|
| Wiring (imports, class, stubs, re-declared types) | 563 | ~150 | meta on routes, no helper imports, no re-typed Gate unions |
| Transport preamble | 375 | ~50 | `req.read` header/param schemas |
| Admission | 596 | 0 | guards + meta (one guard piece, ~280 LOC, counted non-edge) |
| Idempotency | 505 | 8 | route option |
| Validation/shape | 703 | ~130 | schemas only (body ~65, query ~30, headers ~10, refinements ~25) |
| Response/envelope/paging | 464 | ~30 | `req.reply`, ~21 `etag:` options, `Page()` |
| Logging | 118 | 0 | built-in access log + `log(auth)` |
| Business | 221 | 221 | unchanged |
| **Total** | **3,545** | **~590–650** | **~12–13 LOC/route, −82%** (NestJS controllers: 111 LOC for the same 8-route family, 13.9/route) |

Non-edge source (evidence ~10.8k): capabilities 2,152 → ~500 (db 368 → 0 V11a + migrate; front 206 → 0 V11a; time 139 → 0 clock.overridable; kit 1,135 → ~380 in `lib/`, with cursor, validate, json and ~195 of http gone to the framework; ledger 264 → ~120, the outbox and job insert become `jobs.enqueue`; web 40 → ~45 with the failure map). Worker 983 → ~600 (runner 326 + trigger ~40 removed, five job contracts replaced by the commands they wrapped). Domain 5,987 → ~4,900 (idempotency piece + repository 147 → 0; pagination 450 → ~150; outcome plumbing 160 → ~30; tx/repository ceremony 200 → ~80; rate counters 58 → ~15; row types/columns/mappers 500 → ~250 via `db.rows` and `lib/`; duplicated search mapper ~100 → 0). Contracts 838 → ~780 (outcome/Failure/Paging/page/IfMatch definitions removed; `actor` stays explicit). Non-edge ~10.8k → ~7.6k (−3.2k, 30%).

Whole app source: ~14.6k → ~8.3k (−6.3k, 43%). Tests: 17 piece-test preambles 1,800 → ~650; kit tests 933 → ~350; front 295, db 252, runner 293, time 114 → 0; e2e boot/reset 250 → ~50: about −3.0k test lines. Briefs: see §3.11.

Caveats, stated once: the guard piece (~280 LOC) and `lib/` modules (~380) are new app files that absorb code the edges lose; the figures above count them. The idempotency domain side is counted as 147 (piece + repository), not the 508 of the domain finding, because that figure included the edge copies already counted under edges.

## 6. Milestones

Each is one lean implement-review-fix workflow (an opus implementer, a few hours), ordered by value. Each lands with its ctx/docs text, its check findings, tests in the owning package and the todo-api proof. No version bump until V11k. Proof lines are the review's checklist.

**V11b — Admission** (§3.1, in-process shortcut). `Guard(Output, { after, optional, meta })`; `GuardInput` with `peer, ip, meta, prior`; sequential guard run; route `meta` parsed against kept guards' shapes at boot; `Rejection.headers` applied from guard rejections; body buffered after admission (content-length precheck kept); in-process shortcut for locally handled requests; token `responseHeaders(auth)` and `log(auth)`; built-in access log line; `guard-order`, `guard-meta-unknown`, `guard-requested-directly`; Admission block in the Serves sheet; http docs page updated.
Proof: node tests: order is declaration order and a rejection stops the chain; `prior` carries the earlier outputs; an `optional` guard sees `undefined` when the route skips it; a route `meta` with an unknown key fails at boot with the allowed keys listed; a 429 with `Retry-After` reaches the client; an oversize body with a bad credential gets 401, not 413; `responseHeaders` appear on a 404 and on a 200; one access log line per request with the `log(auth)` fields. Core test: a request to a locally handled contract makes no transport call and still emits `$sys.request.*`. cli tests: `guard-order` both forms, `guard-meta-unknown`; ctx snapshot shows the Admission block. todo-api: `/stats` is rate limited without authentication; e2e green.

**V11c — Edge I/O and Rejection outputs** (§3.2, §3.3). `req.read`, `errors.input` with defaults and `issueCodes`, `req.reply` with `etag` and 304, `HttpResult`, `IfMatch`/`etag` exports, `rejectable()`/`isRejection`, `Rejection.details` widened, Rejection rendering in method and shorthand forms, removal of `req.input` and the non-raw `req.json/text/formData`, `bearer/canonicalJson/sha256` in `@murmur/node/lib`; rules 5 and 7; Serves sheet bullets and Input-failures table with one rendered 422.
Proof: node tests: each part's failure maps to its configured status/code with zod codes and params in `issues`; strict query rejects unknown and repeated keys; media type 415, malformed JSON 400, non-object body one root issue, empty body `{}`; `req.reply` renders Rejection/null/undefined/object; `If-None-Match` hit gives 304 with the etag; a Rejection from a shorthand route renders through the envelope; a thrown domain error is still 502. Core tests: `rejectable(M)` output type and runtime acceptance; a returned Rejection is a successful delivery (no retry, reply sent, query dedupe holds). cli: Contracts sheet prints `rejectable(Item)`; the Serves sheet shows the failures table; `contracts-json-faithful` accepts `rejectable()`. todo-api: the edge from §4.1 compiles and e2e is green with the 304 and 404 cases removed from app code.

**V11d — Storage primitives** (§3.6, §3.7 without row decoding). `db.transaction(fn)` joining when nested and `await using` removed; `db.insert`; `murmur migrate` + `migrate()` export; migrations default list and the single DDL source; `sqlite:`/`file:` paths; `kv.incr`; `clock.overridable` with `freeze/advance/clear` and the prod warning; "all framework time is the clock" in the defaults sheet; sqlite and kv docs pages.
Proof: node tests: nested `transaction(fn)` joins and the outer rollback undoes the inner write; `kv.once` and `db.*` of the same delivery join; `insert` returns the id; two concurrent `migrate()` on one file apply each migration once; `kv.incr` counts across two connections and resets at the window edge; frozen clock is seen by a second connection; `freeze` throws when not overridable; loader warns in prod. cli: `murmur migrate` applies and reports; help lists it. todo-api: repository rewritten to the callback form; `fakeSqlite({ schema: 'app' })` groundwork (the default list) in place.

**V11e — Jobs** (§3.5). `jobs` capability with `enqueue` joining the transaction, `murmur_jobs`/`murmur_schedules`, runner with `invokeLocal`/`handles` port, `groupKey` FIFO, `dedupeKey` on pending rows, retry from `@Handle(C, { retry })` or policy, `NonRetryableError`, stale reclaim, `@Handle(C, { every })`, stop semantics with the drain budget, `drain()`/`counts()`, `poll: false`, `$sys.job.*`, `murmur tail` kind `job`; `every-input`, `every-format`, `retry-ladder`; jobs docs page; header `schedules` lane; `batch` option removed.
Proof: node tests: an enqueue inside a rolled-back transaction leaves no row; a thrown handler reschedules by the ladder then goes dead at `attempts`; `NonRetryableError` is dead at once; two jobs with one `groupKey` never run concurrently and run in order; a running job can re-enqueue its own `dedupeKey`; a stale `running` row is reclaimed after the piece timeout; a process without the handler never claims the job; `every` fires once across two runtimes on one file; stop waits for an in-flight job up to the piece timeout and releases an unfinished claim; `drain()` runs due jobs and schedules under a frozen clock and returns counts. cli: the three checks; ctx shows the `schedules` lane and the jobs page; `murmur tail` shows a job delivery. todo-api: `TodoCreated` fan-out to a `Notifier` job piece with `every: '1m'` sweep as the example.

**V11f — Idempotent routes** (§3.4). Route option, `murmur_idempotency`, claim/replay/reused/in-progress with `locked_until` reclaim, scope chain, `errors.idempotency`, buffer reuse by `req.read`, sweep on insert; `idempotent-method`, `idempotent-scope`; route table column.
Proof: node tests: same key + same body replays the stored status/headers/body with `Idempotent-Replayed` and fresh `responseHeaders`; same key + different body answers the configured reused mapping; a concurrent second request answers in-progress; a crashed first request (row past `locked_until`) is reclaimed; a 4xx or a throw leaves no row; an anonymous route scopes by `ip`; a bad key format fails as the headers part; expired rows are swept. cli: both checks; ctx column. todo-api: `POST /todos` idempotent; e2e replay case.

**V11g — Tests** (§3.9). `defineCapability({ fake })`, built-in fakes, `testPiece` auto-provisioning, `t.enqueued`/`t.runJobs`, `fakeSqlite({ schema })`, `createTestApp` with `reset`, `murmur test` includes `lib/**`; Tests hint in ctx.
Proof: node tests: `testPiece(P)` with `needs: { db, jobs }` and no `needs` argument runs; `fakeSqlite({ schema: 'app' })` applies another piece's `schema.sql`; `createTestApp()` serves the real guards and `reset()` keeps `murmur_*` tables and clears the clock override; `app.jobs.drain()` runs handlers from every piece. todo-api: all piece tests lose their schema preamble; e2e rewritten on `createTestApp` without spawning the CLI.

**V11h — lib lane, Paging/Page, cursor** (§3.10). `#lib/*` alias in the app template, `lib-pure`, `declared-deps-only` update, `murmur ctx lib/<module>`, Lib section, `Paging()`/`Page()` exports, `cursor` codec, ingress doc sentence replaced, rule 12; `murmur new lib <name>` scaffold.
Proof: lint tests: `lib-pure` fires on `node:fs`, `#capabilities`, top-level `let`, and passes `node:crypto`, `zod`, `#contracts`, `#lib`; cli: `murmur ctx lib/text` prints signatures and tests; a piece brief lists the imported lib signatures only when imported; `Paging({ max: 50 })` and `Page(Item, { cursorField: 'nextCursor' })` appear in the Contracts sheet; cursor round-trips and a tampered cursor decodes to a 400 Rejection. todo-api: `etag.ts` moves to `lib/etag.ts`; `ListTodos` uses `Paging`/`Page`.

**V11i — Processes** (§3.8). `defineApp({ processes })` with `{ pieces, jobs }` entries, `murmur start <process>`, `--only` removed, ingress and jobs follow the loaded set; `request-crosses-process`, `event-crosses-process`; `Process:` header line.
Proof: node tests: a piece outside the process is not constructed, its routes 404, its jobs are not claimed, `jobs: false` stops claiming; cli: `murmur start worker` starts no ingress when no edge is loaded; both checks fire on a split map and stay silent on AMQP for the request case; ctx shows the Process line. todo-api: `processes: { api, worker }` with the notifier in `worker`; two `murmur start` runs on one file deliver a job end to end.

**V11j — Row decoding and table writers** (§3.7 rest). `db.rows/row(Model)`, `table-foreign-write`, rule 11 wording, sqlite docs bullet.
Proof: node tests: integer → boolean and TEXT → array/object by the Model's field types, other columns untouched, a missing column is a decode error naming it, `row` returns `null`; cli: `table-foreign-write` fires on a write to another piece's table and not on a read. todo-api: `TodoRow`/`toTodo` deleted.

**V11k — Sweep and snapshot.** Docs pages, `brief.md` and `spec.md` updated, `no-process-env` message updated, scaffold templates (web capability with the failure map, guard piece, lib module), `murmur new piece --edge` template on `req.read`/`req.reply`, version 0.3.0.
Proof: `murmur check` and `murmur test` green on the framework, todo-api and the scaffolded app; every rule in §3.11 appears in `murmur ctx`; `murmur ctx` of the todo-api edge and domain pieces stays under the ok tier; a cold-writer dry run: an agent given only `murmur ctx` for a new edge produces `read → request → reply` without a helper file.

## 7. Open decisions (all resolved as recommended)

Each recommendation below was taken; 0.3.0 ships them as stated.

1. **"Edges own status codes" bends.** Domain handlers may `return reject(404 | 409 | 410, ...)`; the edge renders it unchanged. Recommendation: accept. Both teams built this exact union by hand (43 wrappers) because a status-less failure forces the edge to re-derive status from a code it also had to invent; the status is the business refusal's meaning, the transport is still the edge's (envelope, headers, replay). The alternative (edges map codes to statuses) is the 464-LOC tail we are removing.
2. **`rejectable(Model)` explicit vs. implicit Rejection on every output.** Recommendation: explicit. The catalog and ctx show which contracts refuse; a cold writer sees `rejectable(Item)` and knows to narrow. Implicit saves one word per contract and hides it.
3. **Principal on the envelope** to drop `actor` from ~28 contracts. Recommendation: no, keep `actor` in inputs. It hides an input from the contract and the catalog; the saving is ~30 LOC and one spread per edge call.
4. **`db.rows/row(Model)` row decoding.** Recommendation: ship it narrow (boolean and JSON codecs by field type, names must match), and write the line that is not crossed: no column selection, no query building, no relations, no computed fields. Measured duplication in both repos justifies the 40 framework lines; if the second pilot asks for more, that is the ORM slope and the answer is `lib/`.
5. **`murmur jobs` CLI (list, retry dead, purge) and dead-letter view.** Recommendation: defer to after the second pilot; `murmur tail` kind `job`, `$sys.job.*` and `counts()` are the readout now. Predicted to be the first "how do I see dead jobs" issue; cheap to add when the queue shape has settled.
6. **`clock.overridable` as a capability option.** It exists because black-box tests of time-dependent workers across processes need one frozen clock; it reads one row per run context. Recommendation: keep, with the prod-mode warning; the alternative (every app writes a clock capability, as the evidence did, 253 LOC) is worse.
7. **Handler-chosen retry time** (`throw new RetryAt(instant)` or `{ retryIn }`). Recommendation: not in v0.3. `@Handle(C, { retry: { attempts, after } })` covers both evidence ladders; a dynamic retry time (an upstream `Retry-After`) is one addition later.
8. **Worker liveness without an edge.** A worker process has no ingress, so no `/healthz`. Recommendation: `capabilities.web.healthz: true` forces the listener with only the built-in `/healthz` (and a piece-served one if loaded). One yaml line, decide at V11i.
9. **Transactional `this.emit` (outbox for events).** Recommendation: no. On the memory transport events are process-local anyway; `jobs.enqueue` of a Command inside the transaction is the durable cross-process path and the warning says so. Revisit when a durable transport exists.
10. **`responseHeaders(auth)` and `log(auth)` on the token vs. guard-contributed.** Recommendation: token. One app-owned place; guards stay pure outputs.

## 8. What stays app-side and why

| Remains | ~LOC (evidence scale) | Why not framework |
|---|---|---|
| Guard piece: credential lookup, target chain, tenant role rank, bucket selection, rate headers | ~280 | The product's permission model; generic only in shape. Written once. NestJS: 339. |
| Body/query/header schemas with refinements | ~130 | The public API; irreducible declarations. |
| Row types for computed fields and cross-piece reads; mappers beyond 0/1 and JSON | ~250 | Column knowledge is the app's; shared row types live in `lib/` (a coupling through lib, accepted and visible in the Lib section). |
| Versioned update / soft delete / restore skeleton, `version_conflict` detail | ~250 | What "stale" and "gone" mean per entity is domain semantics; `IfMatch`/`etag` and `reject()` are the framework's share. A `versionConflict(current)` helper is three lines in `lib/`. |
| Keyset predicate (`limit + 1`, slice, `WHERE (a, id) > (?, ?)`, nulls-last) | ~15 per list, ~150 | SQL shape per table is app code; the cursor codec, `Paging`, `Page` are the framework's share. A `db.page()` builder is the ORM slope (§7.4). |
| Input text normalisation (NFC trim, case fold for uniqueness columns) | ~40 + 20 calls | `.transform` stays banned in contracts (JSON-faithful); a `lib/text` call per field is explicit. |
| Activity log, fan-out, outbound signing, mail rendering, attempt log as job handlers | ~400 | Product features; the framework gives enqueue-in-transaction, retry ladders, group FIFO under them. |
| Text, slug, money, date helpers in `lib/` | ~300 | Product rules over Temporal/Intl/BigInt. |
| Error envelope, input failure map, response headers, log fields | ~35 | Spec-driven shapes, declared once on the token. |
| Test-mode routes that expose `reset/freeze/drain` over HTTP | ~40 | One-line calls into `createTestApp`-equivalent handles; the route family itself is product test API. |

Roughly 1.9k LOC of infrastructure-shaped app code remains against ~5.5k today, and none of it is repeated per piece. Predicted next-tier framework issues for a second pilot of this class, so nobody is surprised: broadcast/non-competing subscriptions for SSE across processes, an outbound signed-delivery attempt log, multipart uploads, CORS for browser clients, handler-chosen retry times, exotic zod issue codes that `issueCodes` cannot rename, and worker liveness (§7.8).

## 9. Where the implementation departs from this design

- [V11b] `prior` is the merged outputs of the guards in `after`/`optional` (§3.1), not keyed by guard; §4.2's `input.prior.authenticate?.userId` is written `input.prior.userId ?? input.ip` in todo-api.
- [V11b] A route `meta` value that fails a kept guard's shape (missing required key, wrong enum) is a boot error `guard-meta-invalid` naming the guard; `murmur check` sees keys only (`guard-meta-unknown`), not values.
- [V11b] `guard-order` also fires when a kept `optional` guard is ordered after the guard that lists it ("reorder the token's guards so Z runs first").
- [V11b] In-process shortcut: `createBus({ localRequests })` defaults to true (core's transport-semantics tests set false); local and transport deliveries share one per-piece gate of `concurrency` slots (no transport fallback); a locally dead-lettered request is not in the transport's dead-letter list (the requester gets the failure reply); the tap and `murmur trace` see local envelopes through `$sys.event.published { local: true, envelope }`.
- [V11b] `responseHeaders(auth)` is not applied to a guard refusal (admission did not pass); the access line is written for every request that matched a route (router 404/405 and the built-in `/healthz` write none).
- [V11b] Route `meta` is typed by the token guards' meta shapes plus an open record, so a route-extra guard's keys compile and are checked at boot.
- [V11b] todo-api keeps its per-process `SlidingWindow` and `bearerOf` until `kv.incr` (V11d) and `bearer` (V11c) exist; the 429 carries `retry-after: 60`.
- [V11c] `req.error` is removed with `req.input` (an edge refuses with `return reject(...)`); `HttpRequest` has no `json/text/formData` at all, a raw route reads its body from `req.raw` (one request type, no raw-only variant).
- [V11c] The `ContractViolationError` default mapping is gone: an invalid input the edge itself passes to `this.request` is 500 `internal`; client input failures come only from `req.read`/the shorthand through `errors.input`.
- [V11c] The shorthand `@Serve(binding, C)` still merges params < query < JSON body; a failure maps to the part that supplied the failing key (a missing key: body on POST/PUT/PATCH/DELETE, else query); a non-JSON body there fails as `mediaType` (it was ignored).
- [V11c] A repeated single-valued query key is the issue `{ path: [key], code: 'repeated_key' }`; `req.reply(undefined)` is 204 whatever `status`; `null` renders 404 `nothing found at <path>`.
- [V11c] `rejectable(M)` is `z.union([strict Rejection, M])` with JSON Schema `title: 'rejectable(M)'` (catalog and the collapsed Contracts line read it) and `isRejectable()`; Rejection first and strict so `rejectable(Empty)` keeps a Rejection; `isRejection` accepts only the Rejection keys.
- [V11c] `IfMatch` is a `z.preprocess` (representable in a contract's JSON Schema) and idempotent: it also accepts the bare inner value, so the edge-read value re-validates in the command; weak ETags and lists fail.
- [V11c] `murmur new piece --edge` writes `req.read`/`req.reply` now (planned for V11k) because `req.input` no longer compiles; todo-api's `POST /todos` has no `idempotent` yet (V11f); `bearer` from `@murmur/node/lib` replaced `bearerOf`.
- [V11c] Each guard receives only its own `meta` keys (carried V11b finding), so the published guard input schema (`additionalProperties: false`) matches what the edge sends.
- [V11c] `req.read` refuses a header schema key that is not lower-case (`MurmurError` `header-key-case`, 500, message names the lower-case form); a missing optional header is typed `T | null` in the `headers` result, matching the runtime `null`. `binding-param-not-in-input` also reports a key of an inline `params: { … }` shape that is not a `:param` of the path.
- [V11d] `clock.freeze/advance/clear` return promises (`await this.clock.freeze(...)`): the overridable write goes through the sqlite lock and joins the delivery's transaction. `fakeClock()` returns a plain `Clock` frozen at its start (`clear()` returns to system time); `FakeClock` and `set` are gone. `Runtime.clock` is exposed (todo-api e2e freezes it for the 429 case).
- [V11d] `capabilities.clock.overridable` is read by the loader (the clock is not a capability entry), pulls `sqlite` into the plan, and the clock attaches after capabilities start; in prod it is the boot warning `clock-overridable-prod` plus one warn log line at start.
- [V11d] `testPiece`/`createTestRuntime` hand their fake clock to a `fakeKv()` in `needs` (`fakeKv(clock?)`), so `t.clock.advance` moves kv windows and `ttlMs`.
- [V11d] `kv.incr` → `{ count, resetAt: Temporal.Instant }`; `db.insert` takes plain identifiers only and returns the given single-column primary key, else `Number(lastInsertRowid)`; default migration entries that match nothing never warn; `migrate(root, env?)` reads `murmur.yaml` + env (not `murmur.config.ts`).
- [V11d] todo-api `CreateTodo` keeps `todo_requests` on `db.transaction(fn)` + `tx.insert` instead of §4.3's `kv.once`: `once` replays `{ first: false }` without the value, so a redelivery could not reply the same todo. `repository.ts` is functions over `Sqlite`; `db.row` waits for V11j.
- [V11d] ctx header `- migrate:` line only for a piece that needs sqlite or carries `schema.sql`; `murmur migrate` is one row in docs/cli.md (page line cap). `@murmur/node/lib` joined the `declared-deps-only` framework list (V11c gap).
- [V11d] `migrate()` / `murmur migrate` refuse a `:memory:` path (message names `capabilities.sqlite.path: sqlite:./app.db`); outside a run, sqlite calls awaited inside a `transaction(fn)` callback join it through a sqlite-local AsyncLocalStorage (was a silent deadlock); the overridable clock treats a settled `onStart` run like no run (timers re-read `murmur_clock`).
- [V11e] The runner port is `ingress.jobTargets()` (contract, piece, timeoutMs, `retry`, `policyRetry`, `every`), `invokeLocal(contract, input, { id, attempt, signal })`, `ready` (resolves after the pieces subscribe) and `report(job.*)`, not `handles(name)`: the runner needs the timeout, the ladder and the schedules; `Bus.policyOf(piece)` gives the resolved policy. Ingress capabilities (http too) get a stop signal of max(longest piece timeout, 2 s).
- [V11e] `jobs` is not in the always-registered built-ins: it is registered when any discovered piece of the app (before `--only`) `needs` it or declares an `every` handler (the planner starts every registered ingress capability with its `needs`, which would open sqlite in every app). Deciding over the whole app means a process whose pieces only handle a job Command (no `needs.jobs`) still runs the runner; a process with no job handler starts it idle (no polling).
- [V11e] A stale claim whose attempt already reached the target's `attempts` (the process died mid-job) goes `dead` with `claim expired after N attempts` and `$sys.job.dead` instead of running again. The runner leases each schedule window once per process and peeks with a plain SELECT before the claim transaction.
- [V11e] `enqueue` → `{ enqueued: boolean }`; a succeeded job row is deleted, so `counts()` is `{ pending, running, dead }` and `drain()` counts `ran` = succeeded, `failed` = rescheduled, `dead`; a failed or released job whose `dedupeKey` has a pending twin yields to it (deleted). A job run is a fresh trace (`$ingress.job`, binding = contract wire name).
- [V11e] A request handler whose contract output accepts `{}` may return nothing (typed `void`, replied `{}`), so job handlers are `Promise<void>` as in §3.5. `every`/`retry` are also checked at the decorator (PieceDefinitionError, same messages as check); `retry` on a non-Command and `every` on a non-Command are refused (`every-input` covers the latter).
- [V11e] Rule 6 has the jobs and bus-redelivery sentences; the `idempotent` client-retry clause waits for V11f. Catalog: an enqueued or scheduled command is kind `job`, a schedule is listed as sender `(every 1m)` (`ContractView.enqueuers`, `PieceView.schedules` in catalog JSON).
- [V11e] Proof "every fires once across two runtimes on one file" runs the two drains in turn: two connections in one process cannot overlap `BEGIN IMMEDIATE` (the sync busy wait blocks the event loop); across processes the lease is the same single statement. todo-api `Notifier` listens to `TodoCreated` per §6, which stays process-local on the memory transport (V11i moves the enqueue or keeps the notifier beside `todos`).
- [V11f] `idempotent-method` and `idempotent-scope` are also boot errors (`MurmurError` with those codes from the route maker, shared core text `idempotentMethodProblem`/`idempotentScopeProblem`); the boot reads the kept guards' Model shapes, `murmur check` follows `X.schema` fields into the referenced Model and accepts any path below a field whose shape it cannot see.
- [V11f] When no scope path has a value the method runs plainly (no row); `locked_until` is the ingress entry's run deadline (piece timeout), not the route `timeoutMs`; complete/release match the claim's `locked_until`, so a run whose row was reclaimed cannot overwrite the new owner; a 2xx body larger than `maxBodyBytes` is answered but not kept (row deleted).
- [V11f] Primary key is `(scope, key)`: the same key on another route of one scope answers `reused` (the fingerprint includes the route key). The http token's `needs` is a getter (`['sqlite']` once one of its routes is idempotent); `createTestRuntime`/`testPiece` keep rows in a private in-memory sqlite. The ctx `idempotent` column and protocol bullet appear only when a served route is idempotent (`scope · ttl 24h`).
- [V11f] Fingerprint = sha256(route key + concrete path and sorted query + canonical JSON body), not route key + body (§3.4): the same key on `DELETE /x/1` then `/x/2` answers `reused` instead of replaying the first resource. Boot scope paths mirror `murmur check`: union/intersection options are merged, below `record`/`any`/`unknown`/`lazy`/`custom`/`pipe` any path resolves. A `text/event-stream` 2xx or one whose `content-length` exceeds `maxBodyBytes` is answered without buffering and not kept. Defaults (header, ttl 24h, 409/422 mapping, `ip`/`peer`) live in core `IDEMPOTENCY_DEFAULTS`/`REQUEST_SCOPE_PATHS`.
- [V11g] `testPiece` is async (`await using t = await testPiece(P)`), `needs` is optional and partial (a passed need wins), and `t.needs.<field>` is the handle the piece got (tests read the faked database through it). `t.enqueued(C)` → `[{ input, options }]`; `t.runJobs()` → `{ ran }` runs the recorded jobs due by `t.clock` that this piece handles, then what they enqueue. The jobs fake writes `murmur_jobs` rows on the piece's faked (or passed) sqlite through the real insert, so an enqueue joins the delivery's `transaction(fn)` and a rollback leaves no job; `t.enqueued(C)` lists the rows still there (a run marks them `ran`), a pending `dedupeKey` ignores the enqueue, and its `drain()` throws naming `t.runJobs()` / `app.jobs.drain()`. `await t.reset()` (async) also deletes the jobs.
- [V11g] `fake(ctx)` gets `{ root, pieceDir, clock, needs }`, not `() => Handle`: the sqlite fake needs the app root and the piece folder, kv the test clock, jobs `needs.sqlite` (the capability's own `needs` by name: the piece's handle of that capability, else the built-in fake). `Piece()` records its defining file (core `pieceFileOf`), so `testPiece` finds the piece folder and the app root (nearest `murmur.config.ts`/`murmur.yaml`); an explicit `fakeSqlite({ schema })` finds both from the calling test file (or `root`/`pieceDir`) and is async. The built-in tokens load their fakes by dynamic import. The `fetch` fake refuses with a message naming `fakeFetch(handler)`; a need without `fake` fails `test-need-unfaked` naming both allowed forms.
- [V11g] `createTestApp({ root?, env?, tap? })` has no `processes` yet (process names arrive with V11i) and also exposes `runtime`. Defaults (overridable through `env`): sqlite file in a temp dir, overridable clock, `jobs.poll` false, every `MURMUR__CAP_*__PORT` 0, log level error, dev mode. `reset()` deletes the rows of every non-`murmur_*` table plus `murmur_jobs`, `murmur_schedules` and `murmur_idempotency`, plus `murmur_kv` (kv values, counters, once markers: app state in a framework table), and clears the clock override.
- [V11g] todo-api e2e runs on `createTestApp` (the 429 case resets instead of a second boot and freezes the clock only for a deterministic `retry-after`, the job case drains). The two tests that spawn the CLI (`murmur dev`/`trace`/`tail`, and the catalog/check/ctx/lint/tsc gate) moved to `tooling.test.ts` instead of being deleted. The Tests hint is a `### tests: testPiece, createTestApp` block closing the Capabilities section of every brief (~200 tokens, not ~100) and replaces the defaults sheet's `testPiece` line. Because auto-faked tests no longer name their needs, the regeneration tests lane also reads `t.needs.<field>`, and a lone field pairs with a lone `context.md` capability. `murmur new piece` scaffolds `await testPiece(P)` with the built-in needs left to the fakes.
- [V11h] `lib-pure` reports every import outside the §3.10 list (an app npm dependency, `murmur/testing`, `@murmur/node/testing` included) with a message naming the allowed list, a relative import with the `#lib/<x>` form, an I/O `node:*` module or `#capabilities/*` with the capability lane, and a top-level `let`/`var` with "use `const`, or keep the state in a capability"; `lib/**/*.test.ts` is exempt. A lib file is any `.ts` under `<nearest package.json dir>/lib/`.
- [V11h] `cursor.decode(binding, raw, Position)` takes a zod schema of the position (the checksum is public, so a client can mint a well-formed cursor of the wrong shape; a failed `safeParse` is the same 400) and `null` → `null` (first page), so the type is `z.output<Position> | null | Rejection`; `encode` stores the position's JSON round trip (a Date or `Temporal.Instant` travels as its ISO string); the cursor is base64url JSON `{ p, c }` with `c` = the first 16 hex of sha256(binding + canonical position), a checksum, not a secret. The 400 is `invalid_cursor` "cursor is not one this list issued; start again without a cursor".
- [V11h] A list that decodes a cursor returns its Rejection, so todo-api `ListTodos` answers `rejectable(Page(Todo))` (§3.10 shows `Page(Item)`); `Page()` titles its schema `Page(Model)` and `rejectable(zodSchema)` takes its label from the schema's meta title (`rejectable(Page(Todo))`). `Paging()` refuses non-positive or non-integer bounds and a default above max (`invalid-schema`, naming `Paging({ max: 100, default: 20 })`); the default default is min(20, max).
- [V11h] `murmur ctx lib/<module>` prints header (file, import line of every export, test/check commands, importing pieces, the purity rule), `## Signatures` (bodies elided), `## Tests`; no footer, tiers or budget; JSON `{ kind: 'ctx', module, sections, tokens }`. The piece brief's `## Lib` (priority 2, after Contracts) comes from the `#lib/*` imports of the folder's non-test `.ts` files, also under `--withhold-code`, and the import skeleton gains `import { <used names> } from '#lib/<x>'`; `#lib/x` resolves to `lib/x.ts` (the template mapping), not through the package.json imports map.
- [V11h] `murmur check` lints `lib/` by default and a path under `lib/` checks the whole app; `murmur new lib <name>` writes `lib/<name>.ts` (one exported function) and its test, and its `next:` lines name the missing `#lib/*` alias when package.json lacks it. The defaults sheet's pointer line also names `Paging`/`Page`. The cli v2 fixture moved `etag.ts` to `lib/` like todo-api. docs/piece-authoring.md inlines the config example and merges two lint rows to stay under the page cap.
- [V11i] The runtime option `only` became `process` (`createRuntime({ process })`, `createTestApp({ process })`), and `murmur dev --only <glob>` became `--process <name>` with `murmur start --only`; a piece outside the process is still imported (the jobs registration reads the whole app) but not constructed, registered or routed. An unknown name or a name on an app without `processes` is the boot error `process-unknown` naming `defineApp({ processes: { api: { pieces: ['api/**'] } } })` or the defined names (`murmur start` exits 4); a non-list `pieces`, or globs that match no discovered piece id (`'pieces/notifier/**'`), is `process-invalid` (core `processNoPieceProblem`: "globs are piece ids (pieces/<id>/piece.ts → '<id>'), e.g. …"), which `murmur check` reports too for every entry, on `murmur.config.ts`; the banner appends `process=<name>`.
- [V11i] `jobs: false` empties the process's job targets: no claims, no schedule leases, `drain()` runs nothing; `enqueue` still writes rows. `capabilities.web.healthz` is a key of the http config (default false): the loader adds every ingress whose config declares `healthz` and resolves it true to the plan, so it listens with only the built-in `/healthz`; the off line reads `no loaded piece serves through it (capabilities.web.healthz: true listens for /healthz only)`.
- [V11i] `murmur check` reads `processes` by importing `murmur.config.ts` in the describe worker (env evaluated, so a `process.env` spread counts) and treats the transport as memory when `createMemoryTransport(` is the only `create*Transport(` call in the config (a config that picks AMQP or memory by env is `other`) or `transport` is an object named `memory`. A bad `capabilities.web.healthz` value plans the ingress so its config resolution reports the coerce error (was read as false). `event-crosses-process` is silent off the memory transport like the request check (on AMQP events reach every process). A route's guards count as requests of the edge that serves it.
- [V11i] The ctx Process line sits in the header command block, only when `processes` is defined: `- process: \`api\` (requests: all 8 handled here) · run: \`pnpm exec murmur start api\`` (unreached contracts listed instead; no reachability off the memory transport; `none (…)` when no entry lists the piece).
- [V11i] todo-api: `todos` enqueues `NotifyTodo` (dedupe `notify:<id>`) inside the `CreateTodo` transaction and the notifier no longer subscribes `TodoCreated`, which stays in `api` on the memory transport; `processes: { api: { pieces: ['api/**', 'auth', 'todos', 'stats'], jobs: false }, worker: { pieces: ['notifier'] } }`. No `healthz` in its yaml.
- [V11i] todo-api `todos/context.md` writes `Needs: db=sqlite, jobs=jobs`: with two bare capabilities the regeneration needs lane cannot pair the tests' lone `t.needs.db` field (V11g pairing needs one field and one capability).
- [V11i] Follow-up, not done: the regeneration needs lane pairs a lone `t.needs.<field>` only with a lone bare capability, so todo-api `todos/context.md` keeps `Needs: db=sqlite, jobs=jobs`; pairing by capability name needs the field-to-capability map that regeneration withholds.
- [V11j] `db.rows/row` parse the decoded row with the Model after the codecs (extra columns dropped, `0n/1n` count as 0/1, a `z.tuple` field is JSON like an array); a value the Model refuses is a `SqliteError` naming the column, not a silent pass-through. A missing column throws even for an optional field (NULL is a value; `SELECT NULL AS note` when absent).
- [V11j] `table-foreign-write` reads string/template literals and `.insert('table', …)` calls in a piece's non-test `.ts` files (fixtures skipped) against tables a `schema.sql` inside another **piece** folder creates; tables from group folders or `migrations/*.sql` have no owner and are not checked. Rule 11's lead "One concept, one owner of its storage" is kept; only heuristic 2 changes.
- [V11j] todo-api `ListTodos` decodes its keyset rows with a piece-private `PositionedTodo` Model (`Todo` fields + `created_at`, `seq`) and maps them to `Todo`: the keyset columns are app code (§8), and `Todo` cannot carry them.
- [V11k] "Docs pages" = a sweep, not new pages: `docs/api-preview.md` now shows todo-api at 0.3.0 (notifier section, `contracts/notifications.ts`, `processes`, idempotent `POST /todos`, `SearchTodos`) and every `.ts`/`.sql`/`.yaml` file block equals the app file (cli `docs.test.ts`); `.agents/docs/spec.md` and `brief.md` describe 0.3.0.
- [V11k] The guard scaffold needed a fix the design did not list: `murmur new contract --kind guard --output key:type` wrote `Guard({ … })`, which throws (a Guard output must be a Model); it now writes `export class <Class>Output extends Model({ … }) {}` + `Guard(<Class>Output)`. `new piece --handles <Guard>` writes `Promise<Out | Rejection>` with `return reject(401, 'credentials required')` when `authorization` is absent and a test that delivers both. The web template spells out the default `errors.input` map (no `envelope`/`idempotency`, whose defaults need no edit to read).
- [V11k] Cold-writer dry run: one headless opus writer, prompt = only `murmur ctx api/notes --withhold-code` of a new edge (context.md: `GET /notes/:id` → `GetNote`, ETag, 404) in a fresh `murmur new app`, tools = Write. It wrote `req.read({ params }) → this.request(GetNote) → req.reply(note, { etag })` in piece.ts alone (no helper file), `murmur check` and `tsc` green, first attempt. Brief gaps it showed: it added `import { z } from 'zod'` (the edge skeleton lists no zod import; `GetNote.input` would have needed none) and kept a redundant `if (note === null) return null` before `req.reply`.
- [V11k] Rule 8's transaction sentence ships as "`await this.db.transaction(async (tx) => …)`; a nested call joins" and rule 6 keeps the bus-redelivery recipe and "emits stay at-least-once"; the todo-api tooling test checks those spellings in every piece brief, plus `sizing: ok` (was ok or large).
