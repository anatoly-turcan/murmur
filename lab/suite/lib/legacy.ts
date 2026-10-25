import { readFileSync } from 'node:fs';
import { before } from 'node:test';
import { Client, type Json } from './client.ts';
import { crLevel, crMode, type CrId, type CrMode } from './cr.ts';
import type { User } from './fixtures.ts';

// Written by scripts/seed-legacy.ts against the build that precedes the migration (README "Legacy dataset").
export interface LegacyUser {
  id: number;
  email: string;
  name: string;
  key: string;
  keyId: number;
  created_at: string;
}

export interface LegacyObject {
  id: number;
  created_at: string;
  [extra: string]: Json;
}

export interface LegacyManifest {
  version: 1;
  seededAt: string;
  seedMode: CrMode;
  users: Record<'ana' | 'bo' | 'cy' | 'dee', LegacyUser> & { extras: LegacyUser[] };
  workspaces: Record<'alpha' | 'beta' | 'gamma', LegacyObject>;
  projects: Record<'alpha' | 'beta' | 'gamma', LegacyObject>;
  tasks: Record<'t1' | 't2' | 't3' | 'beta' | 'gamma', LegacyObject>;
  comments: Record<'c1', LegacyObject>;
  webhooks: LegacyObject[];
  events: Record<'t1Created', LegacyObject>;
  idempotency: { key: string; path: string; body: Json; status: number; text: string };
  cursor: { path: string; query: Record<string, string | number>; cursor: string };
}

const PATH = process.env.SUITE_LEGACY_MANIFEST ?? '';

export function loadLegacy(): LegacyManifest | null {
  return PATH ? (JSON.parse(readFileSync(PATH, 'utf8')) as LegacyManifest) : null;
}

// A legacy file for CR-N needs SUITE_CR >= CR-N and a dataset seeded on a build from before CR-N.
export function legacySkip(cr: CrId, manifest: LegacyManifest | null): string | false {
  if (crLevel(crMode) < crLevel(cr)) return `${cr} tests run only with SUITE_CR=${cr} or later (current: ${crMode})`;
  if (!manifest) return 'needs SUITE_LEGACY_MANIFEST (a dataset seeded with scripts/seed-legacy.ts before the migration)';
  if (crLevel(manifest.seedMode) >= crLevel(cr)) return `the legacy dataset was seeded at ${manifest.seedMode}; ${cr} migration tests need a dataset seeded before ${cr}`;

  return false;
}

export function legacyUser(u: LegacyUser): User {
  return { id: u.id, email: u.email, name: u.name, timezone: 'UTC', key: u.key, keyId: u.keyId, client: new Client(u.key), raw: u };
}

// The legacy phase must run before any test resets the database (scripts/run.sh orders it).
export function requireLegacyDataset(manifest: LegacyManifest | null, skip: string | false): void {
  if (skip || !manifest) return;
  before(async () => {
    const res = await legacyUser(manifest.users.ana).client.get('/v1/users/me');
    if (res.status !== 200) {
      throw new Error(`legacy dataset missing (GET /v1/users/me as the seeded user → ${res.status}); run the legacy files through scripts/run.sh before anything resets the database`);
    }
  });
}
