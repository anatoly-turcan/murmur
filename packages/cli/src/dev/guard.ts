import type { IncomingMessage } from 'node:http';

export const DEV_UI_ORIGIN = 'http://localhost:5173';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const WILDCARD = new Set(['0.0.0.0', '[::]']);

function hostnameOf(host: string | undefined): string | null {
  if (host === undefined) {
    return null;
  }

  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function hostAllowed(req: IncomingMessage, boundHost: string): boolean {
  const bound = boundHost.includes(':') ? `[${boundHost}]` : boundHost;
  if (WILDCARD.has(bound)) {
    return true;
  }

  const hostname = hostnameOf(req.headers.host);

  return hostname !== null && (hostname === bound || LOOPBACK.has(hostname));
}

function originAllowed(req: IncomingMessage): boolean {
  const { origin, host } = req.headers;

  return origin === undefined || origin === DEV_UI_ORIGIN || origin === `http://${host}`;
}

function jsonBody(req: IncomingMessage): boolean {
  const type = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();

  return req.method !== 'POST' || type === 'application/json';
}

export function rejection(req: IncomingMessage, boundHost: string): string | null {
  if (!hostAllowed(req, boundHost)) {
    return `host ${req.headers.host} not allowed`;
  }

  if (!originAllowed(req)) {
    return `origin ${req.headers.origin} not allowed`;
  }

  if (!jsonBody(req)) {
    return 'POST requires content-type application/json';
  }

  return null;
}
