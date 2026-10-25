import { etag as strongEtag, isRejection, MurmurError, type Rejection } from 'murmur';

import { traceHeaders } from '../trace-headers.ts';
import type { HttpRoute } from './binding.ts';
import { failureFor, rejectionFailure, renderFailure, type ErrorSettings } from './errors.ts';

const NO_BODY = 204;
const NOT_MODIFIED = 304;

export type ReplyBody<O> = Exclude<O, Rejection | Response | null | undefined>;

export interface ReplyOptions<B = never> {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly etag?: string | number | ((body: B) => string | number);
}

export interface OutcomeContext {
  readonly route: HttpRoute;
  readonly errors: ErrorSettings;
  readonly traceId: string;
  readonly request: Request;
  readonly path: string;
}

export function withHeaders(response: Response, extra: Readonly<Record<string, string>>): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extra)) {
    headers.set(name, value);
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function rejectionResponse(rejection: Rejection, errors: ErrorSettings, traceId: string): Response {
  return withHeaders(renderFailure(rejectionFailure(rejection), errors, traceId), rejection.headers ?? {});
}

function etagOf(body: unknown, options: ReplyOptions<unknown>): string | undefined {
  const { etag } = options;
  if (etag === undefined) {
    return undefined;
  }

  return strongEtag(typeof etag === 'function' ? etag(body) : etag);
}

function notModified(request: Request, tag: string): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false;
  }

  const listed = (request.headers.get('if-none-match') ?? '').split(',');
  const tags = new Set(listed.map((value) => value.trim().replace(/^W\//, '')));

  return tags.has(tag) || tags.has('*');
}

function bodyResponse(body: unknown, ctx: OutcomeContext, options: ReplyOptions<unknown>): Response {
  const status = options.status ?? ctx.route.options.status ?? 200;
  const tag = etagOf(body, options);
  const headers = { ...options.headers, ...(tag === undefined ? {} : { etag: tag }) };

  if (tag !== undefined && notModified(ctx.request, tag)) {
    return new Response(null, { status: NOT_MODIFIED, headers });
  }

  if (status === NO_BODY) {
    return new Response(null, { status, headers });
  }

  return Response.json(body, { status, headers });
}

function plainOutcome(outcome: unknown, ctx: OutcomeContext, options: ReplyOptions<unknown>): Response {
  if (isRejection(outcome)) {
    return withHeaders(rejectionResponse(outcome, ctx.errors, ctx.traceId), options.headers ?? {});
  }

  if (outcome === null) {
    const failure = failureFor(404, `nothing found at ${ctx.path}`);

    return withHeaders(renderFailure(failure, ctx.errors, ctx.traceId), options.headers ?? {});
  }

  if (outcome === undefined) {
    return new Response(null, { status: NO_BODY, headers: options.headers ?? {} });
  }

  return bodyResponse(outcome, ctx, options);
}

export function renderOutcome(
  outcome: unknown,
  ctx: OutcomeContext,
  options: ReplyOptions<unknown> = {},
): Response {
  if (outcome instanceof Response) {
    return options.headers === undefined ? outcome : withHeaders(outcome, options.headers);
  }

  if (ctx.route.raw) {
    throw new MurmurError(`${ctx.route.key} is a raw binding: return a Response`, { retryable: false });
  }

  return plainOutcome(outcome, ctx, options);
}

export function withTraceHeaders(response: Response, traceId: string): Response {
  return withHeaders(response, traceHeaders(traceId));
}

export function withoutBody(response: Response): Response {
  void response.body?.cancel().catch(() => {});

  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function whenSent(response: Response, onSent: () => void): Response {
  if (response.body === null) {
    onSent();

    return response;
  }

  const watched = response.body.pipeThrough(new TransformStream({ flush: onSent, cancel: onSent }));

  return new Response(watched, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
