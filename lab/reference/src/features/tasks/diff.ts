import type { Changes } from '../../domain/events.ts';

type Snapshot = Record<string, unknown>;

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function changesBetween(before: Snapshot, after: Snapshot, fields: readonly string[]): Changes {
  const changes: Changes = {};
  for (const field of fields) {
    if (!sameValue(before[field], after[field])) changes[field] = { from: before[field], to: after[field] };
  }

  return changes;
}
