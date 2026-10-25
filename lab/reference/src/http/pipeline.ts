import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requestContext, withAuditContext } from '../audit/context.ts';
import { one } from '../db/sql.ts';
import { workspaceRoleFor } from '../domain/orgs.ts';
import { limitsOf } from '../domain/plans.ts';
import type { OrgRole, Plan, Role } from '../domain/rows.ts';
import { deprecationHeaders, legacyWindowOpen, resolveLegacy } from '../ids/legacy.ts';
import { errorFields } from '../log.ts';
import { appNow } from '../time/clock.ts';
import type { App } from './app.ts';
import { authenticate, type AuthResult } from './auth.ts';
import { readBody, isJsonMediaType, type RawBody } from './body.ts';
import { createContext, routeBody, type RequestState } from './context.ts';
import {
  ApiError,
  conflict,
  errorBody,
  internalError,
  invalidApiKey,
  methodNotAllowed,
  notFound,
  rateLimited,
  unauthenticated,
} from './errors.ts';
import { clientIp, headerValue } from './headers.ts';
import { complete, fingerprint, isValidIdempotencyKey, lookupOrReserve, release, type StoredResponse } from './idempotency.ts';
import { bucketsFor, checkAndCount, type OrganizationBucket } from './rate-limit.ts';
import { outgoingFrom, write, type Outgoing } from './respond.ts';
import type { RouteMatch } from './router.ts';
import type { Actor, Route } from './types.ts';
import type { Id } from '../ids/uuid.ts';

interface Scope {
  scopeWorkspaceId: Id | null;
  scopeRole: Role | null;
  organization: OrganizationBucket | null;
}

type LegacyUse = 'none' | 'read' | 'mutation' | 'missing';

interface ScopeRow {
  org_id: Id;
  plan: Plan;
  ws_role: Role | null;
  org_role: OrgRole | null;
}

interface IdempotencyContext {
  scope: string;
  key: string;
  fingerprint: string;
}

const NO_SCOPE: Scope = { scopeWorkspaceId: null, scopeRole: null, organization: null };

export function errorOutgoing(err: ApiError): Outgoing {
  return outgoingFrom({ status: err.status, body: errorBody(err), headers: err.headers });
}

function withHeaders(out: Outgoing, headers: Record<string, string> | undefined): Outgoing {
  return headers ? { ...out, headers: { ...out.headers, ...headers } } : out;
}

function isGuarded(match: RouteMatch, pathname: string): boolean {
  if (match.kind === 'route') return match.route.auth !== 'none';

  return pathname === '/v1' || pathname.startsWith('/v1/');
}

function isExempt(match: RouteMatch, guarded: boolean): boolean {
  return match.kind === 'route' ? match.route.rateLimit === false : !guarded;
}

function resolveScope(app: App, match: RouteMatch, actor: Actor | null): Scope {
  if (match.kind !== 'route' || !match.route.scope || !actor) return NO_SCOPE;
  const workspaceId = match.route.scope(app.db, match.params);
  if (workspaceId === null) return NO_SCOPE;
  const row = one<ScopeRow>(
    app.db,
    `SELECT w.organization_id AS org_id, o.plan, m.role AS ws_role, om.role AS org_role FROM workspaces w
       JOIN organizations o ON o.id = w.organization_id
       LEFT JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ?1
       LEFT JOIN org_memberships om ON om.organization_id = w.organization_id AND om.user_id = ?1
      WHERE w.id = ?2`,
    actor.user.id,
    workspaceId,
  );
  const role = row ? workspaceRoleFor(row.ws_role, row.org_role) : null;
  if (!row || !role) return NO_SCOPE;

  return { scopeWorkspaceId: workspaceId, scopeRole: role, organization: { id: row.org_id, limit: limitsOf(row.plan).api_requests_per_minute } };
}

function authFailure(auth: AuthResult): ApiError {
  return auth.kind === 'missing' ? unauthenticated() : invalidApiKey();
}

function deprecated(app: App, state: RequestState, out: Outgoing): Outgoing {
  return state.legacy.used && out.status < 400 ? withHeaders(out, deprecationHeaders(app.db)) : out;
}

function handleAudited(state: RequestState) {
  const audit = requestContext({ user: state.actor?.user ?? null, apiKeyId: state.actor?.keyId ?? null, ip: state.ip, requestId: state.requestId });

  return withAuditContext(audit, () => state.route.handle(createContext(state)));
}

async function execute(app: App, state: RequestState): Promise<Outgoing> {
  if (state.legacy.mutation) return errorOutgoing(notFound());
  try {
    return deprecated(app, state, outgoingFrom(await handleAudited(state)));
  } catch (err) {
    if (err instanceof ApiError) return errorOutgoing(err);
    app.log.error('unhandled error', { method: state.route.method, path: state.route.path, ...errorFields(err) });

    return errorOutgoing(internalError());
  }
}

function parsedForFingerprint(route: Route, req: IncomingMessage, body: RawBody): unknown {
  if (routeBody(route) !== 'json' || body.size === 0) return body.size === 0 ? {} : undefined;
  if (!isJsonMediaType(headerValue(req, 'content-type'))) return undefined;
  try {
    return JSON.parse(body.bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

function idempotencyContext(state: RequestState): IdempotencyContext | null {
  if (!state.route.idempotent) return null;
  const key = headerValue(state.req, 'idempotency-key');
  if (key === undefined || !isValidIdempotencyKey(key)) return null;
  const scope = state.route.idempotencyScope === 'ip' || !state.actor ? `ip:${state.ip}` : `user:${state.actor.user.id}`;
  const parsed = parsedForFingerprint(state.route, state.req, state.body);
  const fp = fingerprint(state.route.method, state.url.pathname, state.body.bytes.toString('utf8'), parsed);

  return { scope, key, fingerprint: fp };
}

function storedFrom(out: Outgoing): StoredResponse {
  const headers: Record<string, string> = {};
  for (const name of ['Content-Type', 'ETag']) if (out.headers[name]) headers[name] = out.headers[name];

  return { status: out.status, headers, body: out.bodyText ?? '' };
}

function replay(stored: StoredResponse): Outgoing {
  return { status: stored.status, bodyText: stored.body === '' ? null : stored.body, headers: { ...stored.headers, 'Idempotent-Replayed': 'true' } };
}

async function executeIdempotent(app: App, state: RequestState, idem: IdempotencyContext): Promise<Outgoing> {
  const decision = lookupOrReserve(app.db, idem.scope, idem.key, idem.fingerprint, state.now);
  if (decision.kind === 'replay') return replay(decision.response);
  if (decision.kind === 'reused') {
    return errorOutgoing(new ApiError(422, 'idempotency_key_reused', 'This Idempotency-Key was used with a different request.'));
  }
  if (decision.kind === 'in_progress') {
    return errorOutgoing(conflict('idempotency_in_progress', 'A request with this Idempotency-Key is still being processed.'));
  }
  let out: Outgoing | undefined;
  try {
    out = await execute(app, state);

    return out;
  } finally {
    if (out && out.status >= 200 && out.status < 300) complete(app.db, idem.scope, idem.key, storedFrom(out));
    else release(app.db, idem.scope, idem.key);
  }
}

function runRoute(app: App, state: RequestState): Promise<Outgoing> {
  const idem = idempotencyContext(state);

  return idem ? executeIdempotent(app, state, idem) : execute(app, state);
}

interface Prepared {
  url: URL;
  now: number;
  ip: string;
  match: RouteMatch;
  legacy: LegacyUse;
  guarded: boolean;
  auth: AuthResult;
  actor: Actor | null;
}

function resolveLegacyParams(app: App, match: RouteMatch, now: number): { match: RouteMatch; legacy: LegacyUse } {
  if (match.kind !== 'route' || match.legacy.length === 0) return { match, legacy: 'none' };
  if (match.route.method !== 'GET') return { match, legacy: 'mutation' };
  if (!legacyWindowOpen(app.db, now)) return { match, legacy: 'missing' };
  const params = { ...match.params };
  for (const ref of match.legacy) {
    const uuid = resolveLegacy(app.db, ref.kind, ref.legacyId);
    if (uuid === null) return { match, legacy: 'missing' };
    params[ref.param] = uuid;
  }

  return { match: { ...match, params }, legacy: 'read' };
}

function prepare(app: App, req: IncomingMessage): Prepared {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const now = appNow(app.db, app.config.testMode);
  const { match, legacy } = resolveLegacyParams(app, app.router.match(req.method ?? 'GET', url.pathname), now);
  const guarded = isGuarded(match, url.pathname);
  const auth: AuthResult = guarded ? authenticate(app.db, headerValue(req, 'authorization'), now) : { kind: 'missing' };
  const actor = auth.kind === 'ok' ? { user: auth.user, keyId: auth.keyId } : null;

  return { url, now, ip: clientIp(req, app.config.trustProxy), match, legacy, guarded, auth, actor };
}

async function processRequest(app: App, req: IncomingMessage, body: RawBody): Promise<{ out: Outgoing; actorId: Id | null }> {
  const p = prepare(app, req);
  const requestId = randomUUID();
  const scope = resolveScope(app, p.match, p.actor);
  const rate = isExempt(p.match, p.guarded)
    ? null
    : checkAndCount(app.db, bucketsFor({ ip: p.ip, keyId: p.actor?.keyId ?? null, ...scope }), p.now);
  const finish = (out: Outgoing) => ({ out: withHeaders(out, { ...rate?.headers, 'X-Request-Id': requestId }), actorId: p.actor?.user.id ?? null });
  if (rate && !rate.allowed) return finish(errorOutgoing(rateLimited()));
  if (p.guarded && !p.actor) return finish(errorOutgoing(authFailure(p.auth)));
  if (p.match.kind === 'none') return finish(errorOutgoing(notFound()));
  if (p.match.kind === 'method_not_allowed') return finish(errorOutgoing(methodNotAllowed(p.match.allowed)));
  if (p.legacy === 'missing') return finish(errorOutgoing(notFound()));
  const state: RequestState = {
    app,
    req,
    url: p.url,
    body,
    now: p.now,
    ip: p.ip,
    actor: p.actor,
    route: p.match.route,
    params: p.match.params,
    scopeWorkspaceId: scope.scopeWorkspaceId,
    scopeRole: scope.scopeRole,
    legacy: { used: p.legacy === 'read', mutation: p.legacy === 'mutation' },
    requestId,
  };

  return finish(await runRoute(app, state));
}

function logRequest(app: App, req: IncomingMessage, status: number, started: number, actorId: Id | null): void {
  const path = (req.url ?? '/').split('?')[0];
  app.log.info('request', { method: req.method, path, status, ms: Math.round(performance.now() - started), actor: actorId });
}

export async function handleRequest(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = performance.now();
  const body = await readBody(req);
  let result: { out: Outgoing; actorId: Id | null };
  try {
    result = await processRequest(app, req, body);
  } catch (err) {
    app.log.error('request failed', errorFields(err));
    result = { out: errorOutgoing(err instanceof ApiError ? err : internalError()), actorId: null };
  }
  await write(res, result.out);
  logRequest(app, req, result.out.status, started, result.actorId);
}
