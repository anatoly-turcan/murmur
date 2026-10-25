import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { env } from './env.ts';
import type { Json } from './client.ts';

export type Behaviour =
  | { kind: 'respond'; status: number; delayMs?: number; location?: string }
  | { kind: 'blackhole' }
  | { kind: 'destroy' };

export type BehaviourFn = (req: Received, index: number) => Behaviour;

export interface Received {
  index: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  raw: Buffer;
  text: string;
  json: Json;
  receivedAt: number;
  respondedAt: number | null;
  status: number | null;
}

export const ok = (delayMs = 0): Behaviour => ({ kind: 'respond', status: 200, delayMs });
export const fail = (status = 500): Behaviour => ({ kind: 'respond', status });
export const slow = (delayMs: number, status = 200): Behaviour => ({ kind: 'respond', status, delayMs });
export const redirect = (location = 'http://127.0.0.1:1/elsewhere'): Behaviour => ({ kind: 'respond', status: 302, location });
export const blackhole = (): Behaviour => ({ kind: 'blackhole' });

export interface Receiver {
  url: string;
  requests: Received[];
  readonly maxInFlight: number;
  setBehaviour(b: Behaviour | BehaviourFn): void;
  waitForCount(n: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');

  return out;
}

function parseJson(text: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function startReceiver(initial: Behaviour | BehaviourFn = ok()): Promise<Receiver> {
  let behaviour: BehaviourFn = typeof initial === 'function' ? initial : () => initial;
  const requests: Received[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let inFlight = 0;
  let maxInFlight = 0;

  const respond = (res: ServerResponse, record: Received, b: Extract<Behaviour, { kind: 'respond' }>): void => {
    const finish = (): void => {
      if (res.destroyed) return;
      const headers: Record<string, string> = { 'content-type': 'text/plain' };
      if (b.location) headers.location = b.location;
      res.writeHead(b.status, headers);
      res.end('ok');
      record.respondedAt = Date.now();
      record.status = b.status;
    };
    if (!b.delayMs) return finish();
    const t = setTimeout(() => {
      timers.delete(t);
      finish();
    }, b.delayMs);
    timers.add(t);
  };

  const server = createServer((req, res) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      inFlight -= 1;
    };
    res.on('finish', done);
    res.on('close', done);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const text = raw.toString('utf8');
      const record: Received = {
        index: requests.length,
        method: req.method ?? '',
        path: req.url ?? '',
        headers: flattenHeaders(req),
        raw,
        text,
        json: parseJson(text),
        receivedAt: Date.now(),
        respondedAt: null,
        status: null,
      };
      requests.push(record);
      const b = behaviour(record, record.index);
      if (b.kind === 'respond') return respond(res, record, b);
      if (b.kind === 'destroy') req.socket.destroy();
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, env.receiverBind, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${env.receiverHost}:${port}/hook`,
    requests,
    get maxInFlight() {
      return maxInFlight;
    },
    setBehaviour(b) {
      behaviour = typeof b === 'function' ? b : () => b;
    },
    async waitForCount(n, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.ok(requests.length >= n, `receiver expected ≥${n} requests within ${timeoutMs} ms, got ${requests.length}`);
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// SPEC 8.2: lowercase hex HMAC-SHA256 of "<timestamp>.<raw body bytes>" keyed by the endpoint secret.
export function sign(secret: string, timestamp: string, raw: Buffer): string {
  return createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), raw])).digest('hex');
}

export function assertSigned(secret: string, req: Received): void {
  const ts = req.headers['x-taskwell-timestamp'];
  const sig = req.headers['x-taskwell-signature'];
  assert.match(ts ?? '', /^\d+$/, `X-Taskwell-Timestamp must be unix seconds, got ${ts}`);
  assert.match(sig ?? '', /^v1=[0-9a-f]{64}$/, `X-Taskwell-Signature must be v1=<64 lowercase hex>, got ${sig}`);
  const expected = Buffer.from(sign(secret, ts, req.raw), 'hex');
  const actual = Buffer.from(sig.slice(3), 'hex');
  assert.ok(timingSafeEqual(expected, actual), `signature mismatch on request #${req.index} (ts=${ts})`);
}
