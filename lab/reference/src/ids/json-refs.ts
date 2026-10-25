import type { LegacyKind } from './legacy.ts';

export interface IdRef {
  kind: LegacyKind;
  name: string;
  value: unknown;
  set(value: unknown): void;
}

const FIELD_KINDS: Record<string, LegacyKind> = {
  user_id: 'user',
  to_user_id: 'user',
  assignee_id: 'user',
  creator_id: 'user',
  author_id: 'user',
  owner_id: 'user',
  actor_id: 'user',
  api_key_id: 'api_key',
  workspace_id: 'workspace',
  require_member_of: 'workspace',
  organization_id: 'organization',
  project_id: 'project',
  task_id: 'task',
  comment_id: 'comment',
  webhook_id: 'webhook',
  delivery_id: 'delivery',
  activity_event_id: 'activity_event',
};

const OBJECT_KINDS: Record<string, LegacyKind> = {
  user: 'user',
  actor: 'user',
  workspace: 'workspace',
  organization: 'organization',
  organizations: 'organization',
  project: 'project',
  task: 'task',
  comment: 'comment',
  webhook: 'webhook',
};

export interface WalkOptions {
  arrays: boolean;
}

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function changeRefs(kind: LegacyKind, name: string, change: Bag, out: IdRef[]): void {
  for (const side of ['from', 'to']) {
    if (side in change) out.push({ kind, name, value: change[side], set: (v) => (change[side] = v) });
  }
}

function fieldRefs(bag: Bag, key: string, parent: string | null, out: IdRef[]): void {
  const value = bag[key];
  const kind = key === 'id' && parent ? OBJECT_KINDS[parent] : FIELD_KINDS[key];
  if (!kind) return;
  if (isBag(value)) return changeRefs(kind, key, value, out);
  const name = key === 'id' ? `${parent === 'organizations' ? 'organization' : parent}_id` : key;
  out.push({ kind, name, value, set: (v) => (bag[key] = v) });
}

function walk(value: unknown, parent: string | null, opts: WalkOptions, out: IdRef[]): void {
  if (Array.isArray(value)) {
    if (opts.arrays) for (const item of value) walk(item, parent, opts, out);

    return;
  }
  if (!isBag(value)) return;
  for (const key of Object.keys(value)) {
    if (key === 'legacy_ids') continue;
    fieldRefs(value, key, parent, out);
    if (isBag(value[key]) || Array.isArray(value[key])) walk(value[key], key, opts, out);
  }
}

// Every id-valued field of a stored or emitted JSON document, with the object kind its key names.
export function idRefs(value: unknown, opts: WalkOptions = { arrays: true }): IdRef[] {
  const out: IdRef[] = [];
  walk(value, null, opts, out);

  return out;
}
