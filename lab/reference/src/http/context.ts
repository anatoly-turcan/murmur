import type { IncomingMessage } from 'node:http';
import type { Role } from '../domain/rows.ts';
import type { App } from './app.ts';
import { isJsonMediaType, parseJson, type RawBody } from './body.ts';
import { legacyWindowOpen, resolveLegacy, resolveLegacyAnyOf } from '../ids/legacy.ts';
import { detail, notFound, payloadTooLarge, unsupportedMediaType, validationFailed } from './errors.ts';
import { assertIdempotencyKey, headerValue, parseIfMatch } from './headers.ts';
import { decodeCursor, encodeCursor, endpointBinding, filterHash } from './pagination.ts';
import { isLegacyRef, LIST_QUERY, parseQuery, type LegacyRef, type QuerySpec, type QueryValues } from './query.ts';
import type { Actor, Ctx, Input, Page, PageBody, Params, Route } from './types.ts';
import type { Id } from '../ids/uuid.ts';

export interface RequestState {
  app: App;
  req: IncomingMessage;
  url: URL;
  body: RawBody;
  now: number;
  ip: string;
  actor: Actor | null;
  route: Route;
  params: Params;
  scopeWorkspaceId: Id | null;
  scopeRole: Role | null;
  legacy: { used: boolean; mutation: boolean };
  requestId: string;
}

export function routeBody(route: Route): 'json' | 'none' {
  return route.body ?? (route.method === 'GET' || route.method === 'DELETE' ? 'none' : 'json');
}

function querySpec(route: Route): QuerySpec {
  return route.list ? { ...LIST_QUERY, ...(route.query ?? {}) } : (route.query ?? {});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertBodyTransport(state: RequestState): void {
  if (state.body.tooLarge) throw payloadTooLarge();
  if (state.body.size > 0 && !isJsonMediaType(headerValue(state.req, 'content-type'))) throw unsupportedMediaType();
}

function parseBodyObject(body: RawBody): Record<string, unknown> {
  if (body.size === 0) return {};
  const parsed = parseJson(body.bytes);
  if (!isPlainObject(parsed)) throw validationFailed([detail('', 'invalid_type')]);

  return parsed;
}

const NO_MATCH = '00000000-0000-0000-0000-000000000000';

function resolveLegacyFilter(state: RequestState, ref: LegacyRef): string | string[] {
  const { db } = state.app;
  if (!legacyWindowOpen(db, state.now)) throw notFound();
  state.legacy.used = true;
  if (ref.kinds.length > 1) return resolveLegacyAnyOf(db, ref.kinds, ref.legacyId);

  return resolveLegacy(db, ref.kinds[0], ref.legacyId) ?? NO_MATCH;
}

function resolveLegacyFilters(state: RequestState, query: QueryValues): QueryValues {
  const out: QueryValues = {};
  for (const [name, value] of Object.entries(query)) out[name] = isLegacyRef(value) ? resolveLegacyFilter(state, value) : value;

  return out;
}

export function computeInput(state: RequestState): Input {
  const json = routeBody(state.route) === 'json';
  if (json) assertBodyTransport(state);
  const ifMatch = state.route.ifMatch ? parseIfMatch(headerValue(state.req, 'if-match')) : null;
  if (state.route.idempotent) assertIdempotencyKey(headerValue(state.req, 'idempotency-key'));
  const query = resolveLegacyFilters(state, parseQuery(state.url.searchParams, querySpec(state.route)));
  const body = json ? parseBodyObject(state.body) : {};

  return { query, body, ifMatch };
}

function memo<T>(fn: () => T): () => T {
  let done = false;
  let value: T;

  return () => {
    if (!done) {
      value = fn();
      done = true;
    }

    return value;
  };
}

export function createContext(state: RequestState): Ctx {
  const { app } = state;
  const binding = endpointBinding(state.route, state.params);
  const input = memo(() => computeInput(state));
  const page = memo((): Page => {
    const { query } = input();
    const cursor = query.cursor as string | undefined;
    const limit = query.limit as number;
    if (cursor === undefined) return { limit, after: null };

    return { limit, after: decodeCursor(app.cursorSecret, cursor, binding, filterHash(query)) };
  });

  return {
    db: app.db,
    config: app.config,
    log: app.log,
    now: state.now,
    ip: state.ip,
    actor: state.actor,
    params: state.params,
    scopeWorkspaceId: state.scopeWorkspaceId,
    scopeRole: state.scopeRole,
    header: (name) => headerValue(state.req, name),
    me() {
      if (!state.actor) throw new Error('route requires an authenticated actor');

      return state.actor.user;
    },
    input,
    page,
    pageOf<R, T = R>(rows: R[], keyOf: (row: R) => unknown[], map?: (row: R) => T): PageBody<T> {
      const { limit } = page();
      const items = rows.length > limit ? rows.slice(0, limit) : rows;
      const next =
        rows.length > limit
          ? encodeCursor(app.cursorSecret, { e: binding, f: filterHash(input().query), k: keyOf(items[items.length - 1]) })
          : null;

      return { data: map ? items.map(map) : (items as unknown as T[]), next_cursor: next };
    },
  };
}
