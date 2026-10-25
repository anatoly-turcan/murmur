import type { DatabaseSync } from 'node:sqlite';
import { idRefs } from './json-refs.ts';
import { legacyIdsOf, legacyWindowOpen } from './legacy.ts';

function legacyIdsFor(db: DatabaseSync, doc: unknown): Record<string, number> {
  const refs = idRefs(doc, { arrays: false }).filter((r) => typeof r.value === 'string');
  const known = legacyIdsOf(db, refs.map((r) => r.value as string));
  const out: Record<string, number> = {};
  for (const ref of refs) {
    const legacy = known.get(ref.value as string);
    if (legacy !== undefined && !(ref.name in out)) out[ref.name] = legacy;
  }

  return out;
}

// During the 30-day window, emitted documents name the old integers of the migrated objects they reference.
export function withLegacyIds<T extends Record<string, unknown>>(db: DatabaseSync, now: number, doc: T): T {
  if (!legacyWindowOpen(db, now)) return doc;
  const legacy = legacyIdsFor(db, doc);

  return Object.keys(legacy).length === 0 ? doc : { ...doc, legacy_ids: legacy };
}
