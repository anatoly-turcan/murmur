import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { badRequest } from './errors.ts';
import type { Params, Route } from './types.ts';
import type { QueryValues } from './query.ts';

const B64URL = /^[A-Za-z0-9_-]+$/;
const MAC_BYTES = 12;

interface CursorPayload {
  e: string;
  f: string;
  k: unknown[];
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

export function endpointBinding(route: Pick<Route, 'method' | 'path'>, params: Params): string {
  const bound = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  return `${route.method} ${route.path}#${bound}`;
}

export function filterHash(query: QueryValues): string {
  const { limit: _limit, cursor: _cursor, ...filters } = query;

  return createHash('sha256').update(canonicalJson(filters)).digest('hex').slice(0, 16);
}

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest().subarray(0, MAC_BYTES);
}

export function encodeCursor(secret: string, payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `c_${body}.${mac(secret, body).toString('base64url')}`;
}

function invalidCursor(): Error {
  return badRequest('invalid_cursor', 'The cursor is invalid or does not match the request filters.');
}

function verifiedPayload(secret: string, cursor: string): CursorPayload {
  if (!cursor.startsWith('c_')) throw invalidCursor();
  const parts = cursor.slice(2).split('.');
  if (parts.length !== 2 || !B64URL.test(parts[0]) || !B64URL.test(parts[1])) throw invalidCursor();
  const given = Buffer.from(parts[1]);
  const expected = Buffer.from(mac(secret, parts[0]).toString('base64url'));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalidCursor();
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as CursorPayload;
    if (typeof payload.e !== 'string' || typeof payload.f !== 'string' || !Array.isArray(payload.k)) throw invalidCursor();

    return payload;
  } catch {
    throw invalidCursor();
  }
}

export function decodeCursor(secret: string, cursor: string, binding: string, hash: string): unknown[] {
  const payload = verifiedPayload(secret, cursor);
  if (payload.e !== binding) throw badRequest('cursor_mismatched', 'The cursor belongs to a different list endpoint.');
  if (payload.f !== hash) throw invalidCursor();

  return payload.k;
}
