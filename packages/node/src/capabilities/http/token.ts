import {
  contractKind,
  defineCapability,
  MurmurError,
  PieceDefinitionError,
  type Capability,
  type CapabilityStart,
  type GuardClass,
  type IngressPort,
  type IngressTarget,
  type CapabilityDefinition,
} from 'murmur';

import { asDatabase } from '../sqlite.ts';
import {
  isHttpRoute,
  makeRoute,
  type AuthHook,
  type AuthOf,
  type HttpMethod,
  type HttpSettings,
  type Maker,
  type RawMaker,
  type RouteOptions,
  type RouteSource,
} from './binding.ts';
import { clientOf } from './client.ts';
import { errorSettings, type ErrorOptions } from './errors.ts';
import { nodeAdapter } from './exchange.ts';
import { assertNoGuardOverlap } from './guards.ts';
import { busHost } from './host.ts';
import { idempotencyStore, type IdempotencyStore } from './idempotency-store.ts';
import { handleHttp } from './pipeline.ts';
import type { HttpRequest } from './request.ts';
import { createRouter } from './router.ts';
import { asHttpServer, httpConfig, listen, type HttpServer } from './server.ts';
import { DEFAULT_MAX_BODY_BYTES, hasIdempotentRoutes, registerSettings } from './settings.ts';

export type TokenAuth<G> = AuthOf<G, {}> extends undefined ? {} : Partial<AuthOf<G, {}>>;

export interface HttpTokenOptions<G extends readonly GuardClass[] = readonly GuardClass[]> {
  readonly name?: string;
  readonly guards?: G;
  readonly errors?: ErrorOptions;
  readonly maxBodyBytes?: number;
  readonly responseHeaders?: (auth: TokenAuth<G>) => Record<string, string>;
  readonly log?: (auth: TokenAuth<G>) => Record<string, unknown>;
}

export interface HttpMakers<G> {
  readonly guards: G;
  readonly '~auth'?: AuthOf<G, {}>;
  readonly get: Maker<G>;
  readonly post: Maker<G>;
  readonly put: Maker<G>;
  readonly patch: Maker<G>;
  readonly delete: Maker<G>;
  readonly raw: RawMaker<G>;
}

export type HttpToken<G extends readonly GuardClass[] = readonly GuardClass[]> = CapabilityDefinition<
  string,
  typeof httpConfig,
  HttpServer
> &
  Capability<string, HttpServer> &
  HttpMakers<G>;

export type RequestOf<T> = T extends HttpMakers<infer G> ? HttpRequest<AuthOf<G, {}>> : never;

const HTTP_DOCS = `# http (ingress, v0.2)

\`capabilities/web/capability.ts\`: \`export default http({ guards: [Authenticate, RateLimit] })\` and
\`export type WebRequest = RequestOf<typeof web>\`. Edge pieces serve routes with \`@Serve(web.get('/todos/:id'))\` on a
method (\`req: WebRequest\`, returns \`Promise<HttpResult>\`) or \`@Serve(web.post('/todos/:id/complete'), CompleteTodo)\`
above the class (input from params < query < JSON body, the output rendered like a returned outcome).

- Makers: \`get/post/put/patch/delete(path, { status?, guards?, skip?, meta?, idempotent?, timeoutMs?, maxBodyBytes? })\`,
  \`raw(method, path)\` (unread body on \`req.raw\`, no limit, must return a \`Response\`; a trailing \`/*rest\` is allowed).
- Guards run in order; the body is read after them. Order is the token's list, then route extras, one at a time;
  the first \`Rejection\` answers (its \`headers\`, e.g. \`retry-after\`, go on the response); outputs merge onto
  \`req.auth\`. A thrown guard → 502 \`upstream_failed\`, a guard timeout → 504 \`timeout\`. An oversize body is
  refused with 413 only after the guards passed.
- \`Guard(Out, { after?, optional?, meta? })\`: \`after\` guards must run first and their outputs are in
  \`input.prior\`; \`optional\` guards run first when the route keeps them (their fields \`| undefined\` in \`prior\`);
  \`meta\` is a zod shape the route fills: \`web.get('/items/:id', { meta: { role: 'member' } })\`, parsed at boot
  (an unknown key fails naming the accepted ones). Guard input: \`headers, params, peer, ip, meta, prior\`.
- Token callbacks: \`responseHeaders(auth)\` adds headers to every response after admission passed;
  \`log(auth)\` adds fields to the one access line per request \`access { method, path, status, ms, traceId }\`.
- Read: \`const { params, query, headers, body } = await req.read({ params?, query?, headers?, body? })\`, each a zod
  object or shape, read in that order; the first failing part answers. \`params\`/\`query\` strings that fail are retried
  JSON-decoded (\`'3'\` → 3); the query is strict (an unknown key or a repeated single-valued key fails, \`z.array()\`
  fields take repeats); header names are lower-case and a missing optional header is \`null\`; the body is read for
  POST/PUT/PATCH/DELETE, empty is \`{}\`, a non-JSON content type fails as \`mediaType\`, bad JSON as \`json\`.
- Input failures: \`errors.input\` maps each part to \`{ status, code }\`; defaults params 404 \`not_found\`,
  query/headers/json/body 400 \`invalid_input\`, mediaType 415 \`unsupported_media_type\`. Issues keep zod's code and
  params: \`issues: [{ path, code, message, minimum?, maximum?, keys?, format? }]\`; \`errors.input.issueCodes\` renames
  codes (\`{ too_small: 'too_short' }\`); a refinement's \`params\` are spread into its issue (\`params: { code: 'x' }\`).
- Answer: \`return req.reply(outcome, { status?, headers?, etag? })\` or return the outcome. A \`Rejection\` renders
  through the envelope with its status/code/details/headers; \`null\` → 404 \`not_found\`; \`undefined\` → 204; an
  object → JSON with \`status\` or the route's. \`etag\` (a value or \`(body) => value\`) sends a strong ETag and a
  GET/HEAD whose \`If-None-Match\` matches answers 304. \`IfMatch\` (murmur) reads \`if-match\` to the inner value.
- Client retries: \`web.post('/orders', { idempotent: { scope: ['auth.userId', 'ip'], ttlMs?: 86_400_000, header?:
  'idempotency-key' } })\` (POST/PUT/PATCH/DELETE, not raw; the http capability then needs sqlite). No header: the
  method runs plainly; a key that is not 1–255 printable ASCII fails as the \`headers\` part. The scope is the first
  path (\`auth.*\`, \`ip\`, \`peer\`) with a value. Same key + same request (sha256 of the route, path, sorted query and
  canonical JSON body) replays the stored 2xx status, headers and body with \`idempotent-replayed: true\`
  (responseHeaders and trace headers fresh); another request → \`errors.idempotency.reused\` (422 \`invalid_input\`);
  still running → \`errors.idempotency.inProgress\` (409 \`conflict\`), reclaimed after the piece timeout. A non-2xx
  answer or a throw keeps no row; a 2xx larger than maxBodyBytes or a \`text/event-stream\` is answered but not kept
  (a retry runs again). Rows live in \`murmur_idempotency\` until \`ttlMs\`.
- Errors: \`{ error: { code, message, issues?, details?, cause? }, traceId }\` or the token's \`errors.envelope(failure)\`;
  \`cause\` on 5xx in dev only. Table: PayloadTooLargeError 413 (body > maxBodyBytes, default 1 MiB),
  NoRouteError 501, RequestTimeoutError/HandlerTimeoutError 504, RemoteError (a thrown domain handler) 502, anything
  else 500 \`internal\`.
- \`req.headers\` is a \`Headers\`; \`req.peer\` is the socket's remote address (\`'127.0.0.1'\`); \`req.ip\` is the first
  \`X-Forwarded-For\` entry when \`capabilities.<name>.trustProxy\` is true (murmur.yaml or
  \`MURMUR__CAP_<NAME>__TRUST_PROXY\`), else \`req.peer\`.
- \`HEAD\` answers through the \`GET\` binding without a body; \`OPTIONS\` lists the served methods. \`GET /healthz\` answers
  \`{ ok: true }\` (GET and HEAD) unless a piece serves the literal path \`GET /healthz\`, which then wins (a param or
  wildcard route that matches \`/healthz\` does not). Every response carries \`x-murmur-trace\` and \`traceparent\`.
- Config: \`port\` (3000), \`host\` (127.0.0.1), \`trustProxy\` (false), \`enabled\` (true), \`healthz\` (false). The
  server does not listen when \`enabled\` is false or when no loaded piece serves through the token (a process of
  \`defineApp({ processes })\` without an edge); \`healthz: true\` listens there anyway with only \`GET /healthz\` (worker
  liveness). A log line says which.
- A client that leaves mid-request gets a bodiless 499 and a debug line, not an error; open streams end on stop.
`;

function assertGuards(guards: readonly unknown[]): void {
  const notGuard = guards.find((guard) => contractKind(guard) !== 'guard');
  if (notGuard !== undefined) {
    throw new PieceDefinitionError(`http({ guards }) takes Guard classes; ${String(notGuard)} is not one`);
  }
}

function ownTargets(ingress: IngressPort, settings: HttpSettings): IngressTarget[] {
  return ingress
    .targets('http')
    .filter((target) => isHttpRoute(target.serve.binding) && target.serve.binding.settings === settings);
}

function requireIngress(ctx: CapabilityStart<typeof httpConfig>): IngressPort {
  if (ctx.ingress === undefined) {
    throw new MurmurError(
      'the http capability needs the runtime ingress port (start it through createRuntime)',
      {
        retryable: false,
      },
    );
  }

  return ctx.ingress;
}

function idempotencyOf(
  ctx: CapabilityStart<typeof httpConfig>,
  settings: HttpSettings,
): IdempotencyStore | undefined {
  if (!hasIdempotentRoutes(settings)) {
    return undefined;
  }

  return idempotencyStore(asDatabase(ctx.needs['sqlite']).handle(), ctx.clock);
}

function startServer(ctx: CapabilityStart<typeof httpConfig>, settings: HttpSettings): Promise<HttpServer> {
  const ingress = requireIngress(ctx);
  const router = createRouter(ownTargets(ingress, settings), settings);
  const host = busHost({
    bus: ctx.bus,
    invoke: ingress.invoke,
    mode: ctx.mode,
    log: ctx.log,
    freshTraceId: () => ctx.ids.uuid(),
    idempotency: idempotencyOf(ctx, settings),
  });

  const { trustProxy } = ctx.config;
  const adapter = nodeAdapter(
    (request, peer) => handleHttp(request, router, host, clientOf(request.headers, peer, trustProxy)),
    ctx.log,
  );

  return listen(ctx.config, adapter.onRequest, adapter.endStreams);
}

function maker(source: RouteSource, method: HttpMethod) {
  return (path: string, options: RouteOptions = {}) => makeRoute(source, method, path, options, false);
}

function rawMaker(source: RouteSource) {
  return (method: HttpMethod | '*', path: string, options: RouteOptions = {}) =>
    makeRoute(source, method, path, options, true);
}

function makersOf(source: RouteSource) {
  return {
    guards: source.settings.guards,
    get: maker(source, 'GET'),
    post: maker(source, 'POST'),
    put: maker(source, 'PUT'),
    patch: maker(source, 'PATCH'),
    delete: maker(source, 'DELETE'),
    raw: rawMaker(source),
  };
}

export function httpToken<const G extends readonly GuardClass[] = []>(
  options: HttpTokenOptions<G> = {},
): HttpToken<G> {
  const guards = options.guards ?? [];
  assertGuards(guards);
  assertNoGuardOverlap(guards, 'the default guards');
  const settings: HttpSettings = {
    guards,
    errors: errorSettings(options.errors),
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    responseHeaders: options.responseHeaders as AuthHook<Record<string, string>> | undefined,
    log: options.log as AuthHook<Record<string, unknown>> | undefined,
  };
  const definition = defineCapability({
    name: options.name ?? 'web',
    ingress: true,
    get needs(): readonly string[] {
      return hasIdempotentRoutes(settings) ? ['sqlite'] : [];
    },
    config: httpConfig,
    docs: HTTP_DOCS,
    start: (ctx) => startServer(ctx, settings),
    stop: (server, signal) => asHttpServer(server).close(signal),
  });

  const token = Object.assign(definition, makersOf({ capability: definition, settings }));
  registerSettings(token, settings);

  return token as unknown as HttpToken<G>;
}
