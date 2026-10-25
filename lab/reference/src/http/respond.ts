import type { ServerResponse } from 'node:http';
import type { Result } from './types.ts';

export interface Outgoing {
  status: number;
  bodyText: string | null;
  headers: Record<string, string>;
  chunks?: Iterable<string>;
}

export function ok(body: unknown, etag?: number): Result {
  return { status: 200, body, etag };
}

export function created(body: unknown, etag?: number): Result {
  return { status: 201, body, etag };
}

export function accepted(body: unknown): Result {
  return { status: 202, body };
}

export function noContent(): Result {
  return { status: 204 };
}

function serialize(body: unknown): string {
  return JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

export function outgoingFrom(result: Result): Outgoing {
  const headers: Record<string, string> = { ...(result.headers ?? {}) };
  if (result.etag !== undefined) headers.ETag = `"${result.etag}"`;
  if (result.stream) return { status: result.status, bodyText: null, headers: { ...headers, 'Content-Type': result.stream.contentType }, chunks: result.stream.chunks };
  if (result.status === 204 || result.body === undefined) return { status: result.status, bodyText: null, headers };
  headers['Content-Type'] = 'application/json; charset=utf-8';

  return { status: result.status, bodyText: serialize(result.body), headers };
}

function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    res.once('drain', resolve);
    res.once('close', resolve);
  });
}

async function writeChunks(res: ServerResponse, out: Outgoing, chunks: Iterable<string>): Promise<void> {
  res.writeHead(out.status, out.headers);
  for (const chunk of chunks) {
    if (res.destroyed) return;
    if (!res.write(chunk)) await drained(res);
  }
  res.end();
}

export async function write(res: ServerResponse, out: Outgoing): Promise<void> {
  if (out.chunks) return writeChunks(res, out, out.chunks);
  const headers: Record<string, string | number> = { ...out.headers };
  if (out.bodyText !== null) headers['Content-Length'] = Buffer.byteLength(out.bodyText);
  res.writeHead(out.status, headers);
  res.end(out.bodyText ?? undefined);
}
