import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import type { Log } from 'murmur';

import { responseSent } from './request.ts';
import type { RequestListener } from './server.ts';

export type FetchHandler = (request: Request, peer: string) => Promise<Response>;

export interface NodeAdapter {
  readonly onRequest: RequestListener;
  endStreams(): void;
}

interface Adapter {
  readonly handle: FetchHandler;
  readonly log: Log;
  readonly streams: Set<ServerResponse>;
}

export class ClientDisconnectedError extends Error {
  override readonly name = 'ClientDisconnectedError';

  constructor() {
    super('the client disconnected before the response was sent');
  }
}

const BODYLESS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const FALLBACK_BASE = 'http://ingress.invalid';
const CLIENT_GONE_CODES: ReadonlySet<string> = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'EPIPE']);

function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (let at = 0; at < req.rawHeaders.length; at += 2) {
    headers.append(req.rawHeaders[at] ?? '', req.rawHeaders[at + 1] ?? '');
  }

  return headers;
}

function baseOf(req: IncomingMessage): string {
  const base = `http://${req.headers.host ?? 'localhost'}`;
  if (URL.canParse(base)) {
    return base;
  }

  return FALLBACK_BASE;
}

// pulls from req only when read: an untouched body is left to node:http, which drains it and keeps the socket alive
function lazyBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        reader ??= (Readable.toWeb(req) as ReadableStream<Uint8Array>).getReader();
        const { value, done } = await reader.read();
        if (done) {
          controller.close();

          return;
        }

        controller.enqueue(value);
      },
      cancel: (reason) => reader?.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

function toWebRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', baseOf(req));
  const init: RequestInit & { duplex?: 'half' } = { method, headers: headersOf(req), signal };

  if (BODYLESS.has(method)) {
    return new Request(url, init);
  }

  return new Request(url, { ...init, body: lazyBody(req), duplex: 'half' });
}

function nodeHeaders(response: Response): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();

  if (cookies.length > 0) {
    headers['set-cookie'] = cookies;
  }

  return headers;
}

function isClientGone(error: unknown): boolean {
  const code: unknown = Reflect.get(Object(error), 'code');
  const name: unknown = Reflect.get(Object(error), 'name');

  return CLIENT_GONE_CODES.has(String(code)) || name === 'AbortError' || name === 'ClientDisconnectedError';
}

function streamFailed(adapter: Adapter, response: Response, error: unknown): void {
  if (isClientGone(error)) {
    return;
  }

  adapter.log.warn('http response stream failed', {
    traceId: response.headers.get('x-murmur-trace'),
    error,
  });
}

async function streamBody(
  adapter: Adapter,
  res: ServerResponse,
  response: Response,
  body: ReadableStream,
): Promise<void> {
  adapter.streams.add(res);
  res.flushHeaders();

  try {
    await pipeline(Readable.fromWeb(body as NodeReadableStream), res);
  } catch (error) {
    streamFailed(adapter, response, error);
  } finally {
    adapter.streams.delete(res);
  }
}

async function writeResponse(adapter: Adapter, res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, response.statusText, nodeHeaders(response));

  if (response.body === null) {
    res.end();

    return;
  }

  await streamBody(adapter, res, response, response.body);
}

function closeReason(res: ServerResponse): Error {
  if (res.writableEnded) {
    return responseSent();
  }

  return new ClientDisconnectedError();
}

function closeSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.once('close', () => controller.abort(closeReason(res)));

  return controller.signal;
}

function adapterFailed(adapter: Adapter, req: IncomingMessage, res: ServerResponse, error: unknown): void {
  adapter.log.warn('http adapter failed before the pipeline answered', {
    method: req.method,
    url: req.url,
    error,
  });

  if (!res.headersSent) {
    res.writeHead(500).end();
  }
}

async function serveNode(adapter: Adapter, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const response = await adapter.handle(
      toWebRequest(req, closeSignal(res)),
      req.socket.remoteAddress ?? '',
    );

    await writeResponse(adapter, res, response);
  } catch (error) {
    adapterFailed(adapter, req, res, error);
  }
}

function endStreams(streams: Set<ServerResponse>): void {
  for (const res of streams) {
    res.destroy();
  }

  streams.clear();
}

export function nodeAdapter(handle: FetchHandler, log: Log): NodeAdapter {
  const adapter: Adapter = { handle, log, streams: new Set() };

  return {
    onRequest: (req, res) => void serveNode(adapter, req, res),
    endStreams: () => endStreams(adapter.streams),
  };
}
