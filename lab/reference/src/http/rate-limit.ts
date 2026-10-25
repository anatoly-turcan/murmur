import type { DatabaseSync } from 'node:sqlite';
import { one, run } from '../db/sql.ts';
import { immediate } from '../db/tx.ts';
import type { Role } from '../domain/rows.ts';
import type { Id } from '../ids/uuid.ts';

const WINDOW_MS = 60_000;
const ROLE_LIMITS: Record<Role, number> = { owner: 600, admin: 600, member: 300, viewer: 60 };

export const LIMITS = { ipUnauthenticated: 30, ipAuthenticated: 1200, keyGeneral: 120 };

export interface Bucket {
  key: string;
  limit: number;
}

export interface OrganizationBucket {
  id: Id;
  limit: number;
}

export interface BucketInput {
  ip: string;
  keyId: Id | null;
  scopeWorkspaceId: Id | null;
  scopeRole: Role | null;
  organization: OrganizationBucket | null;
}

export interface RateDecision {
  allowed: boolean;
  headers: Record<string, string>;
}

export function bucketsFor(input: BucketInput): Bucket[] {
  if (input.keyId === null) return [{ key: `ipu:${input.ip}`, limit: LIMITS.ipUnauthenticated }];
  const ip = { key: `ipa:${input.ip}`, limit: LIMITS.ipAuthenticated };
  if (input.scopeWorkspaceId !== null && input.scopeRole !== null) {
    const workspace = { key: `kws:${input.keyId}:${input.scopeWorkspaceId}`, limit: ROLE_LIMITS[input.scopeRole] };
    const org = input.organization ? [{ key: orgBucketKey(input.organization.id), limit: input.organization.limit }] : [];

    return [ip, workspace, ...org];
  }

  return [ip, { key: `key:${input.keyId}`, limit: LIMITS.keyGeneral }];
}

function windowStart(now: number): number {
  return Math.floor(now / WINDOW_MS) * WINDOW_MS;
}

function orgBucketKey(organizationId: Id): string {
  return `org:${organizationId}`;
}

function count(db: DatabaseSync, bucket: string, start: number): number {
  return one<{ count: number }>(db, 'SELECT count FROM rate_limit_counters WHERE bucket = ? AND window_start = ?', bucket, start)?.count ?? 0;
}

export function organizationRequestCount(db: DatabaseSync, organizationId: Id, now: number): number {
  return count(db, orgBucketKey(organizationId), windowStart(now));
}

function increment(db: DatabaseSync, bucket: string, start: number): void {
  run(
    db,
    `INSERT INTO rate_limit_counters (bucket, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1`,
    bucket,
    start,
  );
}

function headersFor(limit: number, remaining: number, now: number, limited: boolean): Record<string, string> {
  const reset = String(Math.ceil((windowStart(now) + WINDOW_MS - now) / 1000));
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(limit),
    'RateLimit-Remaining': String(Math.max(0, remaining)),
    'RateLimit-Reset': reset,
  };
  if (limited) headers['Retry-After'] = reset;

  return headers;
}

export function checkAndCount(db: DatabaseSync, buckets: Bucket[], now: number): RateDecision {
  const start = windowStart(now);

  return immediate(db, () => {
    const used = buckets.map((b) => ({ ...b, used: count(db, b.key, start) }));
    const allowed = used.every((b) => b.used < b.limit);
    if (allowed) for (const b of used) increment(db, b.key, start);
    const remaining = used.map((b) => ({ limit: b.limit, left: b.limit - b.used - (allowed ? 1 : 0) }));
    const tightest = remaining.reduce((min, b) => (b.left < min.left ? b : min));

    return { allowed, headers: headersFor(tightest.limit, tightest.left, now, !allowed) };
  });
}
