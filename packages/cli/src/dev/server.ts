import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ROUTES, type ApiHandler, type ApiRequest } from './api.ts';
import type { DevContext } from './context.ts';
import { openEventStream, type EventSource } from './events.ts';
import { rejection } from './guard.ts';
import { serveUi } from './ui.ts';

export interface ServerDeps {
  readonly ctx: DevContext;
  readonly events: EventSource;
  readonly ui: { readonly enabled: boolean; readonly dist: string | null };
  readonly host: string;
}

interface CompiledRoute {
  readonly method: string;
  readonly regex: RegExp;
  readonly keys: readonly string[];
  readonly handler: ApiHandler;
}

const MAX_BODY = 1024 * 1024;

function compile(method: string, pattern: string, handler: ApiHandler): CompiledRoute {
  const keys: string[] = [];
  const source = pattern.replace(/:(\w+)/g, (_match, key: string) => {
    keys.push(key);

    return '([^/]+)';
  });

  return { method, regex: new RegExp(`^${source}$`), keys, handler };
}

const COMPILED = ROUTES.map(([method, pattern, handler]) => compile(method, pattern, handler));

class BadRequestError extends Error {}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BadRequestError(`malformed URL escape in ${value}`);
  }
}

function match(
  method: string,
  pathname: string,
): { route: CompiledRoute; params: Record<string, string> } | null {
  for (const route of COMPILED) {
    const found = route.method === method ? route.regex.exec(pathname) : null;
    if (found !== null) {
      return {
        route,
        params: Object.fromEntries(route.keys.map((key, i) => [key, decodeParam(found[i + 1] ?? '')])),
      };
    }
  }

  return null;
}

function baseHeaders(req: IncomingMessage): Record<string, string> {
  const { origin } = req.headers;

  return {
    'cache-control': 'no-store',
    ...(origin === undefined ? {} : { 'access-control-allow-origin': origin, vary: 'origin' }),
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of req as AsyncIterable<Buffer>) {
    bytes += chunk.length;

    if (bytes > MAX_BODY) {
      throw new BadRequestError('request body too large');
    }

    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');

  return text.trim() === '' ? undefined : JSON.parse(text);
}

function sendJson(res: ServerResponse, headers: Record<string, string>, status: number, body: unknown): void {
  res.writeHead(status, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function apiRequest(
  req: IncomingMessage,
  url: URL,
  params: Record<string, string>,
): Promise<ApiRequest> {
  return { params, query: url.searchParams, body: req.method === 'POST' ? await readBody(req) : undefined };
}

async function handleApi(
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const headers = baseHeaders(req);
  if (req.method === 'GET' && url.pathname === '/api/events') {
    openEventStream(deps.events, req, res, headers, url.searchParams);

    return;
  }

  try {
    const found = match(req.method ?? 'GET', url.pathname);
    if (found === null) {
      sendJson(res, headers, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });

      return;
    }

    const result = await found.route.handler(deps.ctx, await apiRequest(req, url, found.params));
    sendJson(res, headers, result.status, result.body);
  } catch (error) {
    const status = error instanceof SyntaxError || error instanceof BadRequestError ? 400 : 500;
    sendJson(res, headers, status, {
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function preflight(req: IncomingMessage, res: ServerResponse): void {
  res
    .writeHead(204, {
      ...baseHeaders(req),
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, last-event-id',
    })
    .end();
}

function dispatch(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> | void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const refused = rejection(req, deps.host);

  if (refused !== null) {
    return sendJson(res, {}, 403, { error: { message: refused } });
  }

  if (req.method === 'OPTIONS') {
    return preflight(req, res);
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(deps, req, res, url);
  }

  if (deps.ui.enabled && req.method === 'GET') {
    return serveUi(res, deps.ui.dist, url.pathname);
  }

  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}

export function createDevServer(deps: ServerDeps): Server {
  return createServer((req, res) => {
    Promise.resolve(dispatch(deps, req, res)).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
      }

      res.end(error instanceof Error ? error.message : String(error));
    });
  });
}
