import type { IncomingMessage } from 'node:http';
import { invalidHeader } from './errors.ts';
import { isValidIdempotencyKey } from './idempotency.ts';

const IF_MATCH_RE = /^"(0|[1-9][0-9]*)"$/;

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];

  return Array.isArray(value) ? value.join(', ') : value;
}

export function parseIfMatch(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = IF_MATCH_RE.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw invalidHeader('If-Match must be a quoted decimal version such as "7".');

  return Number(match[1]);
}

export function assertIdempotencyKey(value: string | undefined): void {
  if (value !== undefined && !isValidIdempotencyKey(value)) {
    throw invalidHeader('Idempotency-Key must be 1-255 printable ASCII characters.');
  }
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = trustProxy ? headerValue(req, 'x-forwarded-for')?.split(',')[0]?.trim() : undefined;

  return forwarded || req.socket.remoteAddress || 'unknown';
}
