import { randomBytes } from 'node:crypto';
import { env } from './env.ts';

export type Json = any;
export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number>;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  key?: string | null;
  authorization?: string;
  body?: unknown;
  rawBody?: string | Uint8Array;
  contentType?: string | null;
  query?: Query;
  headers?: Record<string, string>;
  ip?: string | null;
  idempotencyKey?: string;
  ifMatch?: number | string;
  // Bypasses the SUITE_CR call adaptation (lib/cr-adapter.ts); CR tests use it to send the literal request.
  raw?: boolean;
}

export interface ApiResponse<T = Json> {
  method: string;
  url: string;
  status: number;
  headers: Headers;
  text: string;
  body: T;
  durationMs: number;
}

let ipCounter = randomBytes(2).readUInt16BE(0);

export function nextIp(): string {
  ipCounter = (ipCounter + 1) % 65_000;

  return `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.${1 + (process.pid % 250)}`;
}

export function quoted(version: number | string): string {
  return `"${version}"`;
}

export function buildUrl(path: string, query?: Query): string {
  const url = new URL(env.baseUrl + path);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) url.searchParams.append(name, String(v));
  }

  return url.toString();
}

function buildHeaders(opts: RequestOptions): Headers {
  const headers = new Headers(opts.headers ?? {});
  if (opts.authorization !== undefined) headers.set('authorization', opts.authorization);
  else if (opts.key) headers.set('authorization', `Bearer ${opts.key}`);
  if (opts.ip) headers.set('x-forwarded-for', opts.ip);
  if (opts.idempotencyKey !== undefined) headers.set('idempotency-key', opts.idempotencyKey);
  if (opts.ifMatch !== undefined) {
    headers.set('if-match', typeof opts.ifMatch === 'number' ? quoted(opts.ifMatch) : opts.ifMatch);
  }

  return headers;
}

function buildBody(opts: RequestOptions, headers: Headers): string | Uint8Array | undefined {
  if (opts.rawBody !== undefined) {
    if (opts.contentType) headers.set('content-type', opts.contentType);

    return opts.rawBody;
  }
  if (opts.body === undefined) return undefined;
  if (opts.contentType !== null) headers.set('content-type', opts.contentType ?? 'application/json');

  return JSON.stringify(opts.body);
}

function parseBody(text: string): Json {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function send(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
  const url = buildUrl(path, opts.query);
  const headers = buildHeaders(opts);
  const body = buildBody(opts, headers);
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(env.requestTimeoutMs) });
  } catch (err) {
    throw new Error(`${method} ${url} failed: ${(err as Error).message}`, { cause: err });
  }
  const text = await res.text();

  return {
    method,
    url,
    status: res.status,
    headers: res.headers,
    text,
    body: parseBody(text),
    durationMs: performance.now() - started,
  };
}
