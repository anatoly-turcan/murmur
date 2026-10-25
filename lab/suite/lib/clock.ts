import assert from 'node:assert/strict';
import { expectStatus } from './assert.ts';
import { request } from './client.ts';

// SPEC 13.4: the application clock drives every time rule except per-operation timeouts.

export async function getClock(): Promise<{ now: string; overridden: boolean }> {
  const res = await request('GET', '/__test/clock');
  expectStatus(res, 200, 'GET /__test/clock');

  return res.body;
}

export async function setClock(now: string): Promise<string> {
  const res = await request('PUT', '/__test/clock', { body: { now } });
  expectStatus(res, 200, `PUT /__test/clock ${now}`);
  assert.equal(res.body.overridden, true, 'clock must report overridden: true after PUT');

  return res.body.now;
}

export async function advance(seconds: number): Promise<string> {
  const res = await request('POST', '/__test/clock/advance', { body: { seconds } });
  expectStatus(res, 200, `advance ${seconds}s`);

  return res.body.now;
}

export async function clearClock(): Promise<void> {
  const res = await request('DELETE', '/__test/clock');
  expectStatus(res, 204, 'DELETE /__test/clock');
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function addSeconds(timestamp: string, seconds: number): string {
  return iso(Date.parse(timestamp) + seconds * 1000);
}

export function unixSeconds(timestamp: string): number {
  return Math.floor(Date.parse(timestamp) / 1000);
}

export function localDate(timestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
}

export function utcDatePlusDays(days: number, from = Date.now()): string {
  return iso(from + days * 86_400_000).slice(0, 10);
}
