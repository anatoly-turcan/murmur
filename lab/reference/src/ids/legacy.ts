import type { DatabaseSync } from 'node:sqlite';
import { all, one, placeholders } from '../db/sql.ts';
import type { Id } from './uuid.ts';

export const LEGACY_KINDS = [
  'user',
  'api_key',
  'workspace',
  'organization',
  'project',
  'task',
  'comment',
  'activity_event',
  'org_event',
  'webhook',
  'delivery',
  'email',
] as const;

export type LegacyKind = (typeof LEGACY_KINDS)[number];

const WINDOW_MS = 30 * 86_400_000;
const MIGRATED_AT_KEY = 'ids_migrated_at';

const KIND_BY_SEGMENT: Record<string, LegacyKind> = {
  users: 'user',
  'api-keys': 'api_key',
  workspaces: 'workspace',
  organizations: 'organization',
  members: 'user',
  projects: 'project',
  tasks: 'task',
  comments: 'comment',
  webhooks: 'webhook',
  deliveries: 'delivery',
};

const migratedAtCache = new WeakMap<DatabaseSync, number | null>();

export function kindForSegment(segment: string): LegacyKind | null {
  return KIND_BY_SEGMENT[segment] ?? null;
}

export function recordMigration(db: DatabaseSync, now: number): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(MIGRATED_AT_KEY, String(now));
  migratedAtCache.delete(db);
}

function migratedAt(db: DatabaseSync): number | null {
  if (!migratedAtCache.has(db)) {
    const row = one<{ value: string }>(db, 'SELECT value FROM meta WHERE key = ?', MIGRATED_AT_KEY);
    migratedAtCache.set(db, row ? Number(row.value) : null);
  }

  return migratedAtCache.get(db) ?? null;
}

export function sunsetAt(db: DatabaseSync): number | null {
  const at = migratedAt(db);

  return at === null ? null : at + WINDOW_MS;
}

export function legacyWindowOpen(db: DatabaseSync, now: number): boolean {
  const sunset = sunsetAt(db);

  return sunset !== null && now <= sunset;
}

export function deprecationHeaders(db: DatabaseSync): Record<string, string> {
  return { Deprecation: 'true', Sunset: new Date(sunsetAt(db)!).toUTCString() };
}

export function resolveLegacy(db: DatabaseSync, kind: LegacyKind, legacyId: number): Id | null {
  return one<{ uuid: Id }>(db, 'SELECT uuid FROM legacy_ids WHERE kind = ? AND legacy_id = ?', kind, legacyId)?.uuid ?? null;
}

export function resolveLegacyAnyOf(db: DatabaseSync, kinds: readonly LegacyKind[], legacyId: number): Id[] {
  return all<{ uuid: Id }>(
    db,
    `SELECT uuid FROM legacy_ids WHERE legacy_id = ? AND kind IN (${placeholders(kinds.length)})`,
    legacyId,
    ...kinds,
  ).map((r) => r.uuid);
}

export function legacyIdsOf(db: DatabaseSync, uuids: readonly Id[]): Map<Id, number> {
  const unique = [...new Set(uuids)];
  if (unique.length === 0) return new Map();
  const rows = all<{ uuid: Id; legacy_id: number }>(
    db,
    'SELECT uuid, legacy_id FROM legacy_ids WHERE uuid IN (SELECT value FROM json_each(?))',
    JSON.stringify(unique),
  );

  return new Map(rows.map((r) => [r.uuid, r.legacy_id]));
}
