import type {
  Catalog,
  ContextResponse,
  ContractSchemaResponse,
  EmitRequest,
  EmitResponse,
  EnvelopesPage,
  HealthResponse,
  LogsResponse,
  PieceDetail,
  PieceView,
  Snapshot,
  Trace,
  TreeNode,
} from '@murmur/dev-protocol';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(messageOf(status, body));
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function messageOf(status: number, body: unknown): string {
  const error =
    typeof body === 'object' && body !== null ? (body as { error?: { message?: unknown } }).error : undefined;

  return typeof error?.message === 'string' ? error.message : `HTTP ${status}`;
}

type Query = Record<string, string | number | undefined | null>;

export const API_BASE = '/api';

function url(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }

  const search = params.toString();

  return `${API_BASE}${path}${search ? `?${search}` : ''}`;
}

async function request<T>(path: string, init: RequestInit = {}, query?: Query): Promise<T> {
  const response = await fetch(url(path, query), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, body);
  }

  return body as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const id = (value: string) => encodeURIComponent(value);

export interface EnvelopesQuery {
  readonly trace?: string;
  readonly piece?: string;
  readonly contract?: string;
  readonly limit?: number;
  readonly before?: number;
}

export interface LogsQuery {
  readonly piece?: string;
  readonly trace?: string;
  readonly level?: string;
  readonly limit?: number;
}

export interface DevApi {
  health(): Promise<HealthResponse>;
  snapshot(): Promise<Snapshot>;
  envelopes(query: EnvelopesQuery): Promise<EnvelopesPage>;
  trace(traceId: string): Promise<Trace>;
  tree(): Promise<TreeNode[]>;
  pieces(): Promise<PieceView[]>;
  piece(pieceId: string): Promise<PieceDetail>;
  context(pieceId: string, budget?: number): Promise<ContextResponse>;
  catalog(): Promise<Catalog>;
  contractSchema(name: string): Promise<ContractSchemaResponse>;
  emit(body: EmitRequest): Promise<EmitResponse>;
  restart(): Promise<{ ok: true }>;
  pause(): Promise<{ paused: boolean }>;
  resume(): Promise<{ paused: boolean }>;
  logs(query: LogsQuery): Promise<LogsResponse>;
}

export const api: DevApi = {
  health: () => request('/health'),
  snapshot: () => request('/snapshot'),
  envelopes: (query) => request('/envelopes', {}, { ...query }),
  trace: (traceId) => request(`/traces/${id(traceId)}`),
  tree: () => request('/tree'),
  pieces: () => request('/pieces'),
  piece: (pieceId) => request(`/pieces/${id(pieceId)}`),
  context: (pieceId, budget) => request(`/pieces/${id(pieceId)}/context`, {}, { budget }),
  catalog: () => request('/catalog'),
  contractSchema: (name) => request(`/contracts/${id(name)}/schema`),
  emit: (body) => post('/emit', body),
  restart: () => post('/restart'),
  pause: () => post('/pause'),
  resume: () => post('/resume'),
  logs: (query) => request('/logs', {}, { ...query }),
};

export function eventsUrl(since: number | null): string {
  return url('/events', { since: since ?? undefined });
}
