import type { Delivery, EntryFn, InvokeInit, Log, Rejection } from 'murmur';

import { inboundTrace } from '../trace-headers.ts';
import { authFields, logAccess } from './access-log.ts';
import type { HttpRoute } from './binding.ts';
import { bufferedBody, streamedBody, type IncomingBody } from './body.ts';
import { LOCAL_CLIENT, type Client } from './client.ts';
import { failureFor, failureOf, renderFailure, type ErrorSettings } from './errors.ts';
import { forward } from './forward.ts';
import { runGuards, type GuardBase, type Requester } from './guards.ts';
import type { IdempotencyStore } from './idempotency-store.ts';
import { idempotently } from './idempotency.ts';
import type { InputSource } from './input.ts';
import { createHttpRequest, responseSent } from './request.ts';
import {
  rejectionResponse,
  renderOutcome,
  whenSent,
  withHeaders,
  withoutBody,
  withTraceHeaders,
  type OutcomeContext,
} from './respond.ts';
import type { RouteMatch, Router } from './router.ts';

export interface HttpHost {
  readonly mode: 'dev' | 'prod';
  readonly log: Log;
  readonly auth?: { readonly value: unknown };
  readonly idempotency?: IdempotencyStore | undefined;
  freshTraceId(): string;
  invoke<R>(piece: string, init: InvokeInit, fn: EntryFn<R>): Promise<Awaited<R>>;
  readonly request: Requester;
}

interface Exchange {
  readonly request: Request;
  readonly client: Client;
  readonly url: URL;
  readonly traceId: string;
  readonly router: Router;
  readonly host: HttpHost;
  readonly sent: AbortController;
}

interface Admission {
  auth: unknown;
  admitted: boolean;
}

const HEALTH_PATH = '/healthz';

function traceIdOf(request: Request, host: HttpHost): string {
  const murmur = request.headers.get('x-murmur-trace') ?? undefined;
  const parent = request.headers.get('traceparent') ?? undefined;
  const { traceId, malformed } = inboundTrace(murmur, parent);
  const resolved = traceId ?? host.freshTraceId();

  if (malformed !== undefined) {
    host.log.warn('malformed trace header replaced', { header: malformed.slice(0, 128), traceId: resolved });
  }

  return resolved;
}

function errorsOf(exchange: Exchange, route?: HttpRoute): ErrorSettings {
  return route?.settings.errors ?? exchange.router.settings.errors;
}

const CLIENT_CLOSED_REQUEST = 499;

function clientGone(exchange: Exchange, error: unknown, route?: HttpRoute): Response {
  exchange.host.log.debug('http client went away before the response', {
    traceId: exchange.traceId,
    key: route?.key,
    error,
  });

  return new Response(null, { status: CLIENT_CLOSED_REQUEST });
}

function failed(exchange: Exchange, error: unknown, route?: HttpRoute): Response {
  if (exchange.request.signal.aborted) {
    return clientGone(exchange, error, route);
  }

  const errors = errorsOf(exchange, route);
  const failure = failureOf(error, errors, exchange.host.mode);

  if (failure.status >= 500) {
    exchange.host.log.error('http request failed', { traceId: exchange.traceId, key: route?.key, error });
  }

  return renderFailure(failure, errors, exchange.traceId);
}

function refused(exchange: Exchange, status: number, message: string, allow?: readonly string[]): Response {
  const response = renderFailure(failureFor(status, message), errorsOf(exchange), exchange.traceId);
  if (allow !== undefined) {
    response.headers.set('allow', allow.join(', '));
  }

  return response;
}

function guardBase(exchange: Exchange, match: RouteMatch): GuardBase {
  return {
    transport: 'http',
    operation: match.route.key,
    headers: Object.fromEntries(exchange.request.headers),
    params: match.params,
    peer: exchange.client.peer,
    ip: exchange.client.ip,
  };
}

function rejected(exchange: Exchange, match: RouteMatch, rejection: Rejection): Response {
  return rejectionResponse(rejection, errorsOf(exchange, match.route), exchange.traceId);
}

async function admit(
  exchange: Exchange,
  match: RouteMatch,
  admission: Admission,
): Promise<Response | undefined> {
  const { host } = exchange;
  if (host.auth !== undefined) {
    admission.auth = host.auth.value;
    admission.admitted = true;

    return undefined;
  }

  const run = { base: guardBase(exchange, match), meta: match.route.options.meta ?? {}, options: {} };
  const outcome = await runGuards(match.route.guards, run, host.request);
  admission.auth = outcome.auth;

  if (!outcome.passed) {
    return rejected(exchange, match, outcome.rejection);
  }

  admission.admitted = true;

  return undefined;
}

function outcomeContext(exchange: Exchange, route: HttpRoute): OutcomeContext {
  return {
    route,
    errors: route.settings.errors,
    traceId: exchange.traceId,
    request: exchange.request,
    path: exchange.url.pathname,
  };
}

function inputSource(exchange: Exchange, match: RouteMatch, incoming: IncomingBody): InputSource {
  return {
    method: exchange.request.method,
    headers: exchange.request.headers,
    params: match.params,
    query: exchange.url.searchParams,
    body: incoming.body,
  };
}

async function callTarget(
  exchange: Exchange,
  match: RouteMatch,
  incoming: IncomingBody,
  auth: unknown,
  delivery: Delivery,
): Promise<unknown> {
  const { route, target } = match;
  const source = inputSource(exchange, match, incoming);
  const { contract, get } = target.serve;

  if (contract !== undefined) {
    return forward(source, contract, route, exchange.host.request);
  }

  const req = createHttpRequest({
    source,
    url: exchange.url,
    client: exchange.client,
    auth,
    raw: incoming.raw,
    outcome: outcomeContext(exchange, route),
    signal: AbortSignal.any([exchange.request.signal, exchange.sent.signal]),
  });
  const instance = target.instance();

  return get?.(instance).call(instance, req, delivery);
}

function bodyOf(exchange: Exchange, route: HttpRoute): IncomingBody {
  if (route.raw) {
    return streamedBody(exchange.request);
  }

  const limit = route.options.maxBodyBytes ?? route.settings.maxBodyBytes;

  return bufferedBody(exchange.request, limit, route.key);
}

async function serveEntry(
  exchange: Exchange,
  match: RouteMatch,
  admission: Admission,
  delivery: Delivery,
): Promise<Response> {
  const refusal = await admit(exchange, match, admission);
  if (refusal !== undefined) {
    return refusal;
  }

  const incoming = bodyOf(exchange, match.route);
  const call = {
    route: match.route,
    url: exchange.url,
    headers: exchange.request.headers,
    auth: admission.auth,
    client: exchange.client,
    incoming,
    store: exchange.host.idempotency,
    traceId: exchange.traceId,
  };

  return idempotently(call, async () => {
    const result = await callTarget(exchange, match, incoming, admission.auth, delivery);

    return renderOutcome(result, outcomeContext(exchange, match.route));
  });
}

function invokeInit(exchange: Exchange, route: HttpRoute): InvokeInit {
  return {
    transport: 'http',
    binding: route.key,
    traceId: exchange.traceId,
    payload: { method: exchange.request.method, path: exchange.url.pathname },
    signal: exchange.request.signal,
  };
}

async function entryResponse(exchange: Exchange, match: RouteMatch, admission: Admission): Promise<Response> {
  try {
    return await exchange.host.invoke(match.target.piece, invokeInit(exchange, match.route), (delivery) =>
      serveEntry(exchange, match, admission, delivery),
    );
  } catch (error) {
    return failed(exchange, error, match.route);
  }
}

function admittedResponse(
  exchange: Exchange,
  route: HttpRoute,
  admission: Admission,
  response: Response,
): Response {
  const { responseHeaders } = route.settings;
  if (!admission.admitted || responseHeaders === undefined) {
    return response;
  }

  try {
    return withHeaders(response, responseHeaders(authFields(admission.auth)));
  } catch (error) {
    return failed(exchange, error, route);
  }
}

async function dispatch(exchange: Exchange, match: RouteMatch): Promise<Response> {
  const startedAt = performance.now();
  const admission: Admission = { auth: undefined, admitted: false };
  const answered = await entryResponse(exchange, match, admission);
  const response = admittedResponse(exchange, match.route, admission, answered);
  logAccess(exchange.host.log, match.route.settings, {
    method: exchange.request.method,
    path: exchange.url.pathname,
    status: response.status,
    ms: Math.round(performance.now() - startedAt),
    traceId: exchange.traceId,
    auth: admission.auth,
  });

  return response;
}

function isHealthCheck(request: Request, url: URL): boolean {
  return url.pathname === HEALTH_PATH && (request.method === 'GET' || request.method === 'HEAD');
}

function answer(exchange: Exchange): Promise<Response> | Response {
  const { request, url } = exchange;
  const matched = exchange.router.match(request.method, url.pathname);

  if (matched.kind === 'route' && matched.route.path === HEALTH_PATH) {
    return dispatch(exchange, matched);
  }

  if (isHealthCheck(request, url)) {
    return Response.json({ ok: true });
  }

  if (matched.kind === 'route') {
    return dispatch(exchange, matched);
  }

  if (matched.kind === 'method' && request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { allow: matched.allow.join(', ') } });
  }

  if (matched.kind === 'method') {
    return refused(exchange, 405, `${request.method} is not served at ${url.pathname}`, matched.allow);
  }

  return refused(exchange, 404, `no route for ${request.method} ${url.pathname}`);
}

function finalResponse(exchange: Exchange, response: Response): Response {
  const traced = withTraceHeaders(response, exchange.traceId);
  if (exchange.request.method === 'HEAD') {
    return withoutBody(traced);
  }

  return traced;
}

export async function handleHttp(
  request: Request,
  router: Router,
  host: HttpHost,
  client: Client = LOCAL_CLIENT,
): Promise<Response> {
  const sent = new AbortController();
  const traceId = traceIdOf(request, host);
  const exchange = { request, client, url: new URL(request.url), traceId, router, host, sent };
  const response = finalResponse(exchange, await answer(exchange));

  return whenSent(response, () => sent.abort(responseSent()));
}
