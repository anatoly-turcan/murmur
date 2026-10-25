import type {
  BootReport,
  CapabilityView,
  ContractView,
  Frame,
  PieceView,
  Snapshot,
  StoredEnvelope,
} from '@murmur/dev-protocol';

type Envelope = StoredEnvelope['envelope'];

export function pieceView(name: string, over: Partial<PieceView> = {}): PieceView {
  const segments = name.split('/');

  return {
    name,
    className: null,
    kind: 'domain',
    title: segments.at(-1) ?? name,
    summary: `${name} summary`,
    dir: `pieces/${name}`,
    parent: segments.length > 1 ? segments.slice(0, -1).join('/') : null,
    depth: segments.length - 1,
    children: [],
    needs: [],
    emits: [],
    handles: [],
    config: [],
    policy: {
      concurrency: 1,
      timeoutMs: 30_000,
      retry: { maxAttempts: 5, baseMs: 200, maxMs: 30_000, jitter: 0.2 },
      requestTimeoutMs: 10_000,
    },
    status: 'running',
    counters: { received: 0, acked: 0, failed: 0, retried: 0, deadLettered: 0, inflight: 0 },
    lastDeliveryAt: null,
    p50Ms: null,
    p95Ms: null,
    hasContextMd: true,
    hasTests: true,
    ...over,
  };
}

export function contractView(
  name: string,
  emitters: string[],
  handlers: string[],
  over: Partial<ContractView> = {},
): ContractView {
  return {
    name,
    kind: 'event',
    className: name,
    hasReply: false,
    visibility: 'public',
    scope: null,
    file: `contracts/${name.split('.')[0]}.ts`,
    emitters,
    handlers,
    schema: { payload: { type: 'object' } },
    ...over,
  };
}

export function capabilityView(
  name: string,
  usedBy: string[],
  kind: CapabilityView['kind'] = 'ingress',
): CapabilityView {
  return { name, kind, usedBy };
}

export function todoSnapshot(): Snapshot {
  return {
    app: {
      name: 'todo-api',
      root: '/app',
      transport: 'memory',
      startedAt: '2026-10-24T10:00:00.000Z',
      bootDurationMs: 12,
    },
    pieces: [
      pieceView('todos/create', {
        needs: ['http', 'sqlite'],
        handles: ['todos.create'],
        emits: ['todo.created'],
      }),
      pieceView('todos/list', { needs: ['http', 'sqlite'], handles: ['todos.list'] }),
      pieceView('todos/notify', { handles: ['todos.created-internal'] }),
      pieceView('stats/count', { handles: ['todo.created'] }),
      pieceView('audit/record', { handles: ['todo.created'], emits: ['audit.recorded'] }),
    ],
    contracts: [
      contractView('todos.create', [], ['todos/create'], { hasReply: true }),
      contractView('todo.created', ['todos/create'], ['stats/count', 'audit/record']),
      contractView('todos.created-internal', ['todos/create'], ['todos/notify'], {
        visibility: 'internal',
        scope: 'todos',
      }),
      contractView('audit.recorded', ['audit/record'], []),
    ],
    capabilities: [
      capabilityView('http', ['todos/create', 'todos/list']),
      capabilityView('sqlite', ['todos/create'], 'handle'),
    ],
    warnings: [
      {
        code: 'emitted-never-subscribed',
        subject: 'audit.recorded',
        pieces: ['audit/record'],
        message: 'audit.recorded has no subscriber',
      },
    ],
    lastSeq: 0,
  };
}

export function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    id: 'e1',
    name: 'todo.created',
    traceId: 'trace-1',
    ts: '2026-10-24T10:00:01.000Z',
    hop: 1,
    source: 'todos/create',
    payload: { id: 1 },
    ...over,
  };
}

export function sysEnvelope(
  name: string,
  payload: Record<string, unknown>,
  over: Partial<Envelope> = {},
): Envelope {
  return envelope({ id: `sys-${name}-${Math.random()}`, name: `$sys.${name}`, payload, ...over });
}

export function bootReport(): BootReport {
  return {
    ok: false,
    pieces: [{ name: 'todos/create', file: 'pieces/todos/create/piece.ts', errors: [], warnings: [] }],
    errors: [
      { phase: 'load', message: 'SyntaxError: Unexpected token', file: 'pieces/todos/create/piece.ts' },
    ],
    warnings: [],
  };
}

const ts = '2026-10-24T10:00:00.000Z';

export function everyFrame(snapshot: Snapshot): Frame[] {
  return [
    { frame: 'hello', seq: 0, ts, protocol: 1, snapshot, replayFrom: null },
    { frame: 'env', seq: 1, ts, envelope: envelope(), meta: { internal: false } },
    { frame: 'dev.paused', seq: 2, ts },
    { frame: 'dev.resumed', seq: 3, ts },
    { frame: 'dev.restart', seq: 4, ts, reason: ['pieces/todos/create/piece.ts'] },
    { frame: 'dev.child_exit', seq: 5, ts, code: 0, signal: null, drained: true },
    { frame: 'dev.boot_failed', seq: 6, ts, report: bootReport() },
    { frame: 'dev.boot', seq: 7, ts, snapshot, durationMs: 40 },
    { frame: 'ping', seq: 8, ts },
  ];
}

export function v2Snapshot(): Snapshot {
  const guards = ['auth.Authenticate', 'auth.RateLimit'];

  return {
    ...todoSnapshot(),
    pieces: [
      pieceView('api/rest', {
        className: 'RestApi',
        kind: 'edge',
        serves: ['GET /todos/:id', 'GET /stats'],
        requests: ['todos.GetTodo', 'stats.GetStats'],
      }),
      pieceView('api/feed', {
        className: 'TodosFeed',
        kind: 'mixed',
        serves: ['GET /events/todos'],
        handles: ['todos.TodoCreated'],
      }),
      pieceView('auth', { className: 'Auth', kind: 'domain', handles: guards }),
      pieceView('todos', {
        className: 'Todos',
        kind: 'domain',
        handles: ['todos.GetTodo'],
        emits: ['todos.TodoCreated'],
      }),
      pieceView('stats', {
        className: 'TodoStats',
        kind: 'domain',
        handles: ['stats.GetStats', 'todos.TodoCreated'],
      }),
    ],
    contracts: [
      contractView('auth.Authenticate', [], ['auth'], {
        kind: 'guard',
        className: 'Authenticate',
        hasReply: true,
        requesters: ['(web defaults)'],
      }),
      contractView('auth.RateLimit', [], ['auth'], {
        kind: 'guard',
        className: 'RateLimit',
        hasReply: true,
        requesters: ['(web defaults)'],
      }),
      contractView('todos.GetTodo', [], ['todos'], {
        kind: 'query',
        className: 'GetTodo',
        hasReply: true,
        requesters: ['api/rest'],
      }),
      contractView('stats.GetStats', [], ['stats'], {
        kind: 'query',
        className: 'GetStats',
        hasReply: true,
        requesters: ['api/rest'],
      }),
      contractView('todos.CreateTodo', [], [], { kind: 'command', className: 'CreateTodo', hasReply: true }),
      contractView('todos.TodoCreated', ['todos'], ['stats', 'api/feed'], {
        kind: 'event',
        className: 'TodoCreated',
      }),
    ],
    capabilities: [capabilityView('web', []), capabilityView('sqlite', ['todos', 'stats'], 'handle')],
    routes: [
      { transport: 'http', token: 'web', key: 'GET /todos/:id', piece: 'api/rest', method: 'show', guards },
      {
        transport: 'http',
        token: 'web',
        key: 'GET /stats',
        piece: 'api/rest',
        contract: 'stats.GetStats',
        guards: ['auth.RateLimit'],
      },
      {
        transport: 'http',
        token: 'web',
        key: 'GET /events/todos',
        piece: 'api/feed',
        method: 'stream',
        guards,
      },
    ],
    warnings: [
      {
        code: 'route-family-split',
        subject: '/todos',
        pieces: ['api/rest', 'api/feed'],
        message: 'the /todos family is served by api/rest and api/feed',
      },
      {
        code: 'binding-conflict',
        subject: 'GET /todos/:id',
        pieces: ['api/feed', 'api/rest'],
        message: 'GET /todos/:id is served by api/rest and api/feed',
      },
      {
        code: 'route-shadowed',
        subject: 'GET /todos/archived',
        pieces: ['api/feed', 'api/rest'],
        message: 'GET /todos/archived (api/feed) is shadowed by GET /todos/:id (api/rest)',
      },
      {
        code: 'guard-output-overlap',
        subject: 'GET /todos/:id',
        pieces: ['api/rest'],
        message: 'auth.Authenticate and auth.Session both write userId',
      },
    ],
  };
}

export function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('expected a value, got nothing');
  }

  return value;
}
