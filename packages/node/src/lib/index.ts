import { createHash } from 'node:crypto';

import { reject, type Rejection } from 'murmur';
import type { z } from 'zod';

const BEARER = /^Bearer\s+(\S+)\s*$/i;

export function bearer(header: string | null | undefined): string | null {
  return BEARER.exec(header ?? '')?.[1] ?? null;
}

function byKey([a]: [string, unknown], [b]: [string, unknown]): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sorted);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const entries = Object.entries(value).filter(([, item]) => item !== undefined);

  return Object.fromEntries(entries.toSorted(byKey).map(([key, item]) => [key, sorted(item)]));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

interface CursorBody {
  readonly p: unknown;
  readonly c: string;
}

function checksum(binding: string, position: unknown): string {
  return sha256(`${binding}\n${canonicalJson(position)}`).slice(0, 16);
}

function bodyOf(raw: string): CursorBody | null {
  try {
    const body: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const c: unknown = Reflect.get(Object(body), 'c');

    return typeof c === 'string' && Object.hasOwn(Object(body), 'p') ? (body as CursorBody) : null;
  } catch {
    return null;
  }
}

function encode(binding: string, position: unknown): string {
  const p: unknown = JSON.parse(JSON.stringify(position) ?? 'null');

  return Buffer.from(JSON.stringify({ p, c: checksum(binding, p) })).toString('base64url');
}

function invalidCursor(): Rejection {
  return reject(400, 'cursor is not one this list issued; start again without a cursor', {
    code: 'invalid_cursor',
  });
}

function decode<S extends z.ZodType>(
  binding: string,
  raw: string | null,
  position: S,
): z.output<S> | null | Rejection {
  if (raw === null) {
    return null;
  }

  const body = bodyOf(raw);
  if (body === null || body.c !== checksum(binding, body.p)) {
    return invalidCursor();
  }

  const parsed = position.safeParse(body.p);

  return parsed.success ? parsed.data : invalidCursor();
}

export const cursor = { encode, decode } as const;
