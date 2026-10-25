import { createHmac } from 'node:crypto';
import type { Id } from '../../../ids/uuid.ts';

export type AttemptOutcome = 'success' | 'failure' | 'timeout' | 'error';

export interface AttemptRequest {
  url: string;
  secret: string;
  payload: string;
  event: string;
  deliveryId: Id;
  number: number;
  startedAt: number;
  timeoutMs: number;
}

export interface AttemptResult {
  outcome: AttemptOutcome;
  statusCode: number | null;
  error: string | null;
}

export function signature(secret: string, timestamp: number, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

function headersFor(req: AttemptRequest): Record<string, string> {
  const timestamp = Math.floor(req.startedAt / 1000);

  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Taskwell-Webhooks/1',
    'X-Taskwell-Event': req.event,
    'X-Taskwell-Delivery-Id': String(req.deliveryId),
    'X-Taskwell-Attempt': String(req.number),
    'X-Taskwell-Timestamp': String(timestamp),
    'X-Taskwell-Signature': `v1=${signature(req.secret, timestamp, req.payload)}`,
  };
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function errorText(err: unknown): string {
  const cause = err instanceof Error ? (err.cause as { message?: string } | undefined) : undefined;
  if (cause?.message) return cause.message;

  return err instanceof Error ? err.message : String(err);
}

function classifyFailure(err: unknown, timeoutMs: number): AttemptResult {
  if (isTimeout(err)) return { outcome: 'timeout', statusCode: null, error: `no response within ${timeoutMs} ms` };

  return { outcome: 'error', statusCode: null, error: errorText(err) };
}

export async function sendAttempt(req: AttemptRequest): Promise<AttemptResult> {
  const signal = AbortSignal.timeout(req.timeoutMs);
  try {
    const res = await fetch(req.url, { method: 'POST', headers: headersFor(req), body: req.payload, redirect: 'manual', signal });
    await res.arrayBuffer();
    const success = res.status >= 200 && res.status < 300;

    return { outcome: success ? 'success' : 'failure', statusCode: res.status, error: null };
  } catch (err) {
    return classifyFailure(err, req.timeoutMs);
  }
}
