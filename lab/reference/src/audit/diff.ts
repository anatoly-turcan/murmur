import type { ResourceType } from './snapshots.ts';

export type Diff = Record<string, { from: unknown; to: unknown }>;

type Body = Record<string, unknown>;

const BOOKKEEPING = ['version', 'updated_at'];

const DERIVED: Partial<Record<ResourceType, readonly string[]>> = {
  task: ['completed_at', 'overdue'],
  organization: ['limits'],
  api_key: ['last_used_at'],
};

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? 'null';
}

export function diffOf(type: ResourceType, before: Body | null, after: Body | null): Diff {
  if (!before || !after) return {};
  const skip = new Set([...BOOKKEEPING, ...(DERIVED[type] ?? [])]);
  const diff: Diff = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (skip.has(key)) continue;
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (stableJson(from) !== stableJson(to)) diff[key] = { from, to };
  }

  return diff;
}
