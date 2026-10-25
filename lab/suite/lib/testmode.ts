import assert from 'node:assert/strict';
import { describe, expectStatus } from './assert.ts';
import { request, type Json, type Query } from './client.ts';

export async function reset(): Promise<void> {
  const res = await request('POST', '/__test/reset');
  if (res.status !== 204) throw new Error(`POST /__test/reset must return 204: ${describe(res)}`);
}

export async function drain(): Promise<{ drained: boolean; pending: number; running: number; dead: number }> {
  const res = await request('POST', '/__test/jobs/drain');
  expectStatus(res, 200, 'drain');

  return res.body;
}

export async function tick(): Promise<{ digests_created: number; reminders_created: number }> {
  const res = await request('POST', '/__test/scheduler/tick');
  expectStatus(res, 200, 'scheduler tick');

  return res.body;
}

// SPEC 13.4: with a worker running, drain must finish (deliveries blocked behind an earlier one are not due).
// SUITE_DRAIN_PENDING=any accepts a `pending` count that includes not-yet-due jobs (adjudication aid, not the default).
export async function drainAll(): Promise<void> {
  const res = await drain();
  const anyPending = process.env.SUITE_DRAIN_PENDING === 'any';
  const expectedPending = anyPending ? res.pending : 0;
  assert.deepEqual(
    { drained: res.drained, pending: res.pending, running: res.running },
    { drained: true, pending: expectedPending, running: 0 },
    `drain must report every due job done: ${JSON.stringify(res)}`,
  );
}

export async function tickAndDrain(): Promise<void> {
  await tick();
  await drainAll();
}

export interface EmailFilter {
  to?: string;
  template?: string;
  dedupe_key?: string;
}

export async function emails(filter: EmailFilter = {}): Promise<Json[]> {
  const res = await request('GET', '/__test/emails', { query: filter as Query });
  expectStatus(res, 200, 'GET /__test/emails');
  assert.ok(Array.isArray(res.body?.data), `emails: data must be an array: ${describe(res)}`);

  return res.body.data;
}

export async function clearEmails(): Promise<void> {
  const res = await request('DELETE', '/__test/emails');
  expectStatus(res, 204, 'DELETE /__test/emails');
}

export async function jobs(status?: 'pending' | 'running' | 'succeeded' | 'dead'): Promise<Json[]> {
  const res = await request('GET', '/__test/jobs', { query: { status } });
  expectStatus(res, 200, 'GET /__test/jobs');

  return res.body.data;
}

export async function waitUntil(what: string, check: () => Promise<boolean> | boolean, timeoutMs = 10_000, everyMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(everyMs);
  }
  assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
