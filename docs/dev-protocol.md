# Dev protocol

How tools talk to `murmur dev`: plain HTTP + JSON for requests, Server-Sent Events for the live stream. Types live in
`@murmur/dev-protocol` (`Frame`, `Snapshot`, `Catalog`, `PieceView`, `Trace`, `StoredEnvelope`, `LogLine`, …); the CLI
(`tail`, `trace`, `emit`) and the web UI are its only clients.

- Base URL `http://127.0.0.1:4242` (`murmur dev --port/--host`). The running server writes
  `.murmur/dev.json` `{ pid, port, host, root, startedAt, protocol: 1 }`; clients find it there and check the pid.
- Every API response is JSON (`content-type: application/json`, `Cache-Control: no-store`); errors are
  `{ error: { message, … } }` with a 4xx/5xx status.
- Guard: the `Host` hostname must be the bound host or loopback; `Origin` must be absent, `http://localhost:5173` (the
  Vite dev UI) or `http://<Host>`; every `POST` needs `content-type: application/json`. Otherwise 403.
- Protocol version `1` is in `/api/health` and the `hello` frame.

## HTTP

| Method & path                                                                   | Response                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                                               | `HealthResponse { ok: true, protocol: 1, app, pid, startedAt, pieces, uptimeMs }`                                                                                                                                          |
| `GET /api/snapshot`                                                             | `Snapshot`                                                                                                                                                                                                                 |
| `GET /api/events?since=&piece=&contract=&trace=&kinds=`                         | `text/event-stream`, see below                                                                                                                                                                                             |
| `GET /api/envelopes?trace=&piece=&contract=&limit=&before=`                     | `EnvelopesPage { items: StoredEnvelope[], nextBefore: number \| null }` (limit default 100, max 1000)                                                                                                                      |
| `GET /api/traces/:traceId`                                                      | `Trace`; `:traceId` may be a unique prefix (404 none, 409 `{ error: { message, candidates } }` ambiguous)                                                                                                                  |
| `GET /api/tree`                                                                 | `TreeNode[]`: the folder tree under `pieces/`                                                                                                                                                                              |
| `GET /api/pieces`                                                               | `PieceView[]`                                                                                                                                                                                                              |
| `GET /api/pieces/:id`                                                           | `PieceDetail` (`:id` URL-encoded: `todos%2Fcreate`)                                                                                                                                                                        |
| `GET /api/pieces/:id/context?budget=`                                           | `ContextResponse { markdown, sections: [{ id, title, tokens, level, truncated }], tokens, budget, overBudget, sizing }`                                                                                                    |
| `GET /api/catalog`                                                              | `Catalog`                                                                                                                                                                                                                  |
| `GET /api/contracts/:name/schema`                                               | `ContractSchemaResponse { name, hasReply, payload, reply? }` (JSON Schema)                                                                                                                                                 |
| `POST /api/emit` `{ contract, payload, mode: 'emit' \| 'request', timeoutMs? }` | `EmitResponse { traceId, envelopeId, reply?, durationMs }`; errors `{ error: { name, message, issues? } }`: 400 bad body/payload, 404 unknown contract or no responder, 502 `RemoteError`, 504 timeout, 503 app not booted |
| `POST /api/restart`                                                             | `{ ok: true }` (restarts the app child)                                                                                                                                                                                    |
| `POST /api/pause`, `POST /api/resume`                                           | `{ paused }`; memory transport only, otherwise 409                                                                                                                                                                         |
| `GET /api/logs?piece=&trace=&level=&limit=`                                     | `LogsResponse { items: LogLine[] }` (limit default 200, max 2000)                                                                                                                                                          |

Filters: `piece` and `contract` are globs (`todos/*`, `todos.*`); `trace` is a prefix. `GET /api/pieces/:id/context`
without `budget` does not shrink and judges `sizing` against the app's `limits` (see [cli.md](cli.md), `murmur ctx`).

## Event stream

```
GET /api/events?since=120&piece=todos/*

id: 121
event: env
data: {"frame":"env","seq":121,"ts":"2026-10-24T03:37:23.231Z","envelope":{…},"meta":{"piece":"todos/create","internal":false}}
```

- One SSE message per frame: `id: <seq>`, `event: <frame name>`, `data: <Frame JSON>`.
- `since` is a sequence number (replay everything after it from the buffer, then go live) or an age (`30s`, `5m`,
  `500ms`, `1h`); `Last-Event-ID` works the same as a numeric `since`. If `since` is older than the buffer,
  `hello.replayFrom` is the oldest seq still held.
- `kinds=env,dev.boot` keeps only those frame names; `hello` and `ping` are always sent. `piece`, `contract`, `trace`
  filter `env` frames.
- A `ping` frame every 15 s keeps proxies open.

```ts
type Frame =
  | { frame: 'hello'; seq: number; ts: string; protocol: 1; snapshot: Snapshot; replayFrom: number | null }
  | { frame: 'env'; seq: number; ts: string; envelope: Envelope; meta: EnvMeta }
  | { frame: 'dev.restart'; seq: number; ts: string; reason: string[] }
  | { frame: 'dev.boot'; seq: number; ts: string; snapshot: Snapshot; durationMs: number }
  | { frame: 'dev.boot_failed'; seq: number; ts: string; report: BootReport }
  | {
      frame: 'dev.child_exit';
      seq: number;
      ts: string;
      code: number | null;
      signal: string | null;
      drained: boolean | null;
    }
  | { frame: 'dev.paused' | 'dev.resumed'; seq: number; ts: string }
  | { frame: 'ping'; seq: number; ts: string };

interface EnvMeta {
  piece?: string;
  attempt?: number;
  durationMs?: number;
  failed?: boolean;
  internal: boolean;
}
```

`EnvMeta` is filled by the supervisor: `piece` is the envelope's `source` for user and reply envelopes and the
payload's `piece` for `$sys.*`; `internal` marks `$sys.*` frames (hidden by default in the UI and `murmur tail`).

## Shapes

```ts
interface Snapshot {
  app: { name: string; root: string; transport: string; startedAt: string; bootDurationMs: number };
  pieces: PieceView[];
  contracts: ContractView[];
  capabilities: CapabilityView[];
  routes?: CatalogRoute[];
  warnings: CatalogWarning[];
  lastSeq: number;
}
interface Catalog {
  contracts: ContractView[];
  pieces: PieceView[];
  tree: TreeNode[];
  capabilities: CapabilityView[];
  routes?: CatalogRoute[];
  warnings: CatalogWarning[];
}
interface CatalogRoute {
  transport: string;
  token: string;
  key: string; // 'GET /todos/:id'
  piece: string;
  method?: string; // method form, contract the shorthand form
  contract?: string;
  status?: number;
  guards: string[]; // effective guard wire names
}
interface TreeNode {
  id: string;
  kind: 'group' | 'piece';
  title: string;
  summary: string | null;
  children: TreeNode[];
}
interface PieceView {
  name: string;
  className: string | null;
  kind: 'domain' | 'edge' | 'mixed';
  title: string;
  summary: string | null;
  dir: string;
  parent: string | null;
  depth: number;
  children: string[];
  needs: string[];
  emits: string[];
  handles: string[];
  serves?: string[];
  requests?: string[];
  config: { key: string; type: string; source: 'env' | 'yaml' | 'default' | 'missing'; env: string }[];
  policy: DeliveryPolicy;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  counters: {
    received: number;
    acked: number;
    failed: number;
    retried: number;
    deadLettered: number;
    inflight: number;
  };
  lastDeliveryAt: string | null;
  p50Ms: number | null;
  p95Ms: number | null;
  hasContextMd: boolean;
  hasTests: boolean;
}
interface PieceDetail extends PieceView {
  contextMd: string | null;
  files: { path: string; bytes: number }[];
  recent: StoredEnvelope[];
  logs: LogLine[];
}
interface ContractView {
  name: string;
  kind: 'query' | 'command' | 'event' | 'guard';
  className: string;
  hasReply: boolean;
  visibility: 'public' | 'internal';
  scope: string | null;
  file: string;
  emitters: string[]; // pieces (or `(external: <capability>)`) that emit it as an event
  requesters?: string[]; // call sites that request it: this.request, a route shorthand, a guard (`(<token> defaults)`)
  handlers: string[];
  schema: { payload: unknown; reply?: unknown };
}
interface CapabilityView {
  name: string;
  kind: 'ingress' | 'handle';
  usedBy: string[];
}
interface CatalogWarning {
  code:
    | 'subscribed-never-emitted'
    | 'emitted-never-subscribed'
    | 'requested-never-handled'
    | 'missing-context-md'
    | 'missing-summary'
    | 'missing-tests'
    | 'orphan-contract'
    | 'binding-conflict'
    | 'route-shadowed'
    | 'route-family-split'
    | 'guard-never-handled'
    | 'guard-output-overlap'
    | 'guard-order'
    | 'guard-meta-unknown';
  subject: string; // contract, piece, or route key for route codes
  pieces: string[]; // route codes: every piece involved (both sides of a conflict)
  message: string;
}
interface StoredEnvelope {
  seq: number;
  envelope: Envelope;
  meta: EnvMeta;
}
interface Trace {
  traceId: string;
  root: StoredEnvelope;
  nodes: TraceNode[];
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  failed: boolean;
  maxHop: number;
  background?: { piece: string }; // root of an emit made outside any run
}
interface TraceNode {
  id: string;
  parentId: string | null;
  depth: number;
  envelope: Envelope;
  deliveries: {
    piece: string;
    attempt: number;
    receivedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    outcome: 'acked' | 'failed' | 'retried' | 'deadLettered' | 'inflight';
    error?: string;
    reason?: string; // reason from $sys.delivery.failed/deadlettered, e.g. requester-gone
  }[];
  reply?: { envelopeId: string; durationMs: number; timedOut: boolean; rejected?: number }; // rejected: guard status
  deduped?: { count: number; by: string[] }; // suppressed identical queries, their callers; callersSharing() = count + 1
}
interface LogLine {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  piece: string;
  msg: string;
  traceId?: string;
  eventId?: string;
  fields?: Record<string, unknown>;
  error?: SerializedError;
}
```

`routes`, `serves`, `requests`, `requesters`, `background`, `reason`, `rejected` and `deduped` are optional: a
client renders what is present. Route errors reach the snapshot as warnings.

Config keys never carry values, only their source. `BootReport { ok, pieces, errors, warnings }` (in
`dev.boot_failed`) lists boot errors by phase (`load`, `declaration`, `config`, `needs`, `contracts`, `subscribe`).

## Buffers and files

- Replay buffer: a ring of the last `--replay` (default 5000) `StoredEnvelope`s, indexed by trace and piece.
  `seq` increases for the whole dev session, across app restarts.
- `--payload-cap 16kb` truncates large payloads in frames; `--redact` replaces each payload with `{ $redacted: true, bytes }` (also `$sys.log` fields).
- Traces are written as one NDJSON file of `StoredEnvelope` lines per trace (`.murmur/traces/<traceId>.ndjson`,
  `--trace-dir`), 2 s after the trace goes quiet, capped at 500 files. `murmur trace` falls
  back to them when no dev server runs.
- The app child is stopped with `devStopPolicy` (`graceMs 2000`, `forceMs 500`) on every restart.
