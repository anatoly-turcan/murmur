# Envelope

The wire record every message travels in. One JSON object, eleven known keys, nothing else. Pieces never build envelopes;
the bus does (`createEnvelope`), transports carry them as bytes (`serializeEnvelope` / `parseEnvelope`, all from
`murmur`).

- **Strict:** `parseEnvelope` rejects unknown keys, missing required keys and wrong types with `EnvelopeShapeError`.
  There is no versioning yet, so even an additive wire change is breaking.
- **Idempotency key:** `id`. A retry redelivers the same envelope with the same `id`; dedupe on it
  (`this.kv.once(delivery.envelope.id, …)`, `INSERT OR IGNORE … (event_id)`).
- **One trace per causal chain:** `traceId` is copied from parent to child; `causationId` points at the parent `id`.
- **Limits:** warn at 64 KiB (`bytes` on `$sys.event.published`), reject at 1 MiB (`PayloadTooLargeError`), refuse
  `hop > 32` (`CascadeDepthError`). All three live in `defineApp({ limits: { warnBytes, maxBytes, maxHop } })`.

## Fields

| Field           | Type                                | Required | Rules                                                                                                 |
| --------------- | ----------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `id`            | UUID v4 string                      | yes      | unique per envelope (`ids.uuid()`); same `id` on every redelivery                                     |
| `name`          | string                              | yes      | event name (grammar below); replies use `$reply.<instanceId>`                                         |
| `traceId`       | string matching `^[0-9a-f-]{8,64}$` | yes      | whole causal chain; a root has `traceId === id` unless an ingress supplied one                        |
| `causationId`   | UUID string                         | no       | `id` of the envelope whose handler emitted this one; absent on a root                                 |
| `correlationId` | UUID string                         | no       | request/reply pairing; set on the request and copied to its reply                                     |
| `replyTo`       | string                              | no       | `$reply.<instanceId>`; present only on envelopes from `request()`, which makes the delivery a request |
| `deadline`      | string                              | no       | `Temporal.Instant` when the requester stops waiting (`ts` + request timeout); only on requests        |
| `ts`            | string                              | yes      | `Temporal.Instant` string (UTC `Z`, up to 9 fractional digits); informational, never for ordering     |
| `hop`           | integer ≥ 0                         | yes      | 0 for a root, `parent.hop + 1` otherwise; `$reply.*` envelopes are exempt from `maxHop`               |
| `source`        | string                              | no       | emitting piece id (`billing/invoice`) or `external:<label>` (`external:http`)                         |
| `payload`       | JSON value                          | yes      | validated against the contract before publish; `undefined` is forbidden (use `null` or `{}`)          |

`parseEnvelope` checks shape, types and the `traceId` regex only; it never checks a UUID version or the name grammar.
An ingress (the `http` capability) validates inbound trace ids (`x-murmur-trace`, `traceparent`) against the same regex
and mints a fresh one otherwise, so untrusted input never reaches `parseEnvelope`.

## Example: a request, the event it caused, and the reply

```json
{ "id": "7b00c1a4-1e8e-4d2e-9d3e-6a2f0c3b1d55", "name": "billing.invoice.requested",
  "traceId": "80521f3a-91c2-4b62-8a16-f4a7d9e0c2ab", "correlationId": "c0f1e2d3-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  "replyTo": "$reply.1f9a2b3c", "ts": "2026-10-24T03:37:23.197500977Z", "hop": 0, "source": "external:http",
  "payload": { "customerId": "c1", "lines": [{ "sku": "a", "qty": 1 }] } }
{ "id": "638c7a9e-2b4f-4e1a-b7c3-9d8e7f6a5b4c", "name": "billing.invoice.created",
  "traceId": "80521f3a-91c2-4b62-8a16-f4a7d9e0c2ab", "causationId": "7b00c1a4-1e8e-4d2e-9d3e-6a2f0c3b1d55",
  "ts": "2026-10-24T03:37:23.231000120Z", "hop": 1, "source": "billing/invoice",
  "payload": { "id": "inv-1", "total": 1200 } }
{ "id": "a1b2c3d4-0000-4000-8000-000000000001", "name": "$reply.1f9a2b3c",
  "traceId": "80521f3a-91c2-4b62-8a16-f4a7d9e0c2ab", "causationId": "7b00c1a4-1e8e-4d2e-9d3e-6a2f0c3b1d55",
  "correlationId": "c0f1e2d3-4a5b-4c6d-8e9f-0a1b2c3d4e5f", "ts": "2026-10-24T03:37:23.240000000Z", "hop": 1,
  "source": "billing/invoice", "payload": { "ok": true, "value": { "invoiceId": "inv-1" } } }
```

## Names

```
name     := segment ("." segment)* "." (segment | class)   ; two or more parts, max 255 bytes UTF-8, never "$"
segment  := [a-z] [a-z0-9-]*
class    := [A-Z] [A-Za-z0-9]*                           ; a class name, last part only (todos.CreateTodo)
internal := "$sys" ("." segment)+      ; framework events, see below
reply    := "$reply." [a-z0-9]{8}      ; one reply address per bus instance
pieceId  := segment ("/" segment)*     ; folder path under pieces/, not a wire name
pattern  := AMQP topic: "*" = exactly one segment, "#" = zero or more (observers only)
```

`validateName`, `validatePieceId`, `matchPattern`, `isInternal` are exported from `murmur`. Pieces subscribe by exact
contract name; patterns are for observers (`murmur tail`, the dev server). The piece id's env form is upper-case with
`/` and `-` turned into `_` (`todos/create` → `TODOS_CREATE`), used by the config lane.

## Ids, trace and hops

`createEnvelope({ name, payload, parent?, correlationId?, replyTo?, source?, ids, clock })`:

- `id = ids.uuid()`, `ts = clock.now().toString()`.
- With a parent run context (inside a handler): `traceId = parent.traceId`, `causationId = parent.eventId`,
  `hop = parent.hop + 1`.
- Without one: a root, `traceId = id`, `hop = 0`, no `causationId`. An ingress enters with
  `bus.enter({ piece: 'external:http', traceId? }, fn)`, which runs at hop -1 so its first emit is hop 0, and mints one
  trace id shared by every emit inside that call.

`hop` exists to stop loops: a cascade that re-emits forever fails at hop 33 with `CascadeDepthError` instead of
flooding the broker.

## Encoding

`JSON.stringify`, UTF-8, no BOM, `undefined` fields omitted. Writers use the table's key order; readers must not depend
on it. Size is measured once, at publish. There is no sequence number: ordering is a transport property and never
stronger than "per group, one consumer, prefetch 1".

## `$reply.*`: request and reply

`this.request(Contract, input)` publishes the request with `replyTo = $reply.<this bus's instanceId>` and a fresh
`correlationId`, then waits up to `requestTimeoutMs` (default 10 000) for the reply. The responder's handler return
value is validated against the contract's output schema and sent as:

```json
{ "ok": true, "value": { "invoiceId": "inv-1" } }
{ "ok": false, "error": { "name": "RemoteError", "message": "…", "code": "…", "retryable": false } }
```

A failure reply is sent only when the request is finally dead-lettered (after the last retry). A request is not
retried past its `deadline`: the delivery fails terminally with `reason: 'requester-gone'` and is dead-lettered. On the requester side
`ok: false` becomes a thrown `RemoteError`, a missing reply a `RequestTimeoutError`, no responder a `NoRouteError`.
Replies are non-persistent, expire after `requestTimeoutMs`, are never retried and do not count against `maxHop`.

## `$sys.*`: internal events

The bus, `@murmur/node` and transports publish framework events on `$sys.<area>.<event>` names (`sysEvents` in
`murmur` holds one internal contract per name). Every payload is a JSON object plus `instanceId` and `at`. Tools (CLI
`tail`/`trace`, UI) are built only on these.

| Area       | Events                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runtime    | `runtime.started`, `runtime.stopping`, `runtime.stopped`                                                                                                                                                        |
| piece      | `piece.started`, `piece.stopped`, `piece.failed`                                                                                                                                                                |
| capability | `capability.started`, `capability.stopped`, `capability.failed`                                                                                                                                                 |
| event      | `event.published` (carries `bytes`, `late`, optionally the envelope), `event.unrouted`                                                                                                                          |
| delivery   | `delivery.received`, `delivery.acked`, `delivery.failed` (`willRetry`, `phase`, `reason?`), `delivery.retried`, `delivery.timeout`, `delivery.deadlettered`, `delivery.reply-ignored`, `delivery.zombie-failed` |
| request    | `request.sent`, `request.completed` (`deduped?`), `request.deduped`, `request.timeout`, `request.late-reply`, `request.duplicate-reply`                                                                         |
| ingress    | `ingress.received`, `ingress.completed`, `ingress.failed` (`piece`, `transport`, `binding`, `traceId`, `durationMs`)                                                                                            |
| emit       | `emit.background` (`piece`, `contract`): a piece emitted or requested outside any run                                                                                                                           |
| log        | `log` (`level`, `msg`, `piece`, `traceId?`, `fields?`, `error?`)                                                                                                                                                |
| transport  | `transport.reconnecting`, `transport.reconnected`, `transport.error`                                                                                                                                            |

Rules: a `$sys.*` delivery that fails is acked and logged to the sink, never retried or dead-lettered; work done while
handling one logs to the sink only (no `$sys.log` loops). User contract names can never start with `$`. (A group's
own `contracts.ts` declares _group-internal_ contracts such as `todos.cache.invalidate`: ordinary names, visible only
inside that folder; see [piece-authoring.md](piece-authoring.md).)

## Retries and dead letters (`$dlq.*`)

A failed delivery is retried with exponential backoff and jitter (`DeliveryPolicy.retry`, default
`{ maxAttempts: 5, baseMs: 200, maxMs: 30000, jitter: 0.5 }`) unless the error has `retryable: false`
(`NonRetryableError`, `ContractViolationError`, …). After the last attempt the delivery is dead-lettered:
`$sys.delivery.deadlettered { envelope, attempts, error, phase }` is published, a pending request gets its failure
reply, and the transport nacks without requeue. Payloads that fail validation are dead-lettered at once (`phase:
'validate'`).

The policy is set app-wide in `defineApp({ policy })`, per piece in `Piece({ policy })` and per process in yaml
`pieces.<id>.$policy`; every field is optional and falls back to the defaults above (`concurrency: 8`,
`timeoutMs: 30000`, `requestTimeoutMs: 10000`):

```ts
export default defineApp({
  name: 'todo-api',
  transport: () => createMemoryTransport(),
  capabilities: [sqlite],
  policy: { timeoutMs: 10_000, retry: { maxAttempts: 3, baseMs: 100, maxMs: 5_000 } },
});

export class Mailer extends Piece({ policy: { concurrency: 2, retry: { maxAttempts: 8, jitter: 0 } } }) {}
```

Where dead letters land is the transport's business: the memory transport keeps them in `transport.deadLetters`
(`createTestRuntime().deadLetters()`), AMQP dead-letters durable piece queues through the `murmur.dlx` exchange into the `murmur.dead` queue. The `$dlq.` prefix is reserved
for transports that need a named dead-letter topic; no shipped transport uses it yet.
