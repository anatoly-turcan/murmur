import assert from 'node:assert/strict';
import { crApplied } from './cr.ts';

export type Id = number | string;

export const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// CR-2 replaces integer identifiers with UUIDv7 strings; before it every id is a JSON number.
export function opaqueIds(): boolean {
  return crApplied('CR-2');
}

export const NONEXISTENT_ID: Id = opaqueIds() ? '018f3c1e-0000-7000-8000-00000000dead' : 987_654_321;

// CR-2 keeps ids as tie-breakers in UUID byte order, which for lowercase hex is string order.
export function compareIds(a: Id, b: Id): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const [x, y] = [String(a), String(b)];

  return x < y ? -1 : x > y ? 1 : 0;
}

export function compareIdsDesc(a: Id, b: Id): number {
  return compareIds(b, a);
}

export function idsAsc(...ids: Id[]): Id[] {
  return [...ids].sort(compareIds);
}

export function idsDesc(...ids: Id[]): Id[] {
  return [...ids].sort(compareIdsDesc);
}

export function idFromHeader(raw: string | null | undefined): Id {
  return opaqueIds() ? String(raw ?? '') : Number(raw);
}

export function idPattern(): RegExp {
  return opaqueIds() ? UUIDV7_RE : /^\d+$/;
}

export function assertPublicId(value: unknown, what = 'id'): void {
  if (opaqueIds()) {
    assert.equal(typeof value, 'string', `${what} must be a UUIDv7 string, got ${JSON.stringify(value)}`);
    assert.match(value as string, UUIDV7_RE, `${what} must be a lowercase RFC 9562 UUIDv7`);

    return;
  }
  assert.ok(Number.isSafeInteger(value) && (value as number) > 0, `${what} must be a positive integer, got ${JSON.stringify(value)}`);
}

export function uuidV7Millis(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

// Ordering "created_at asc, id asc" computed from the objects themselves, so expectations hold for any id scheme.
export function byCreation<T extends { id: Id; created_at: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.created_at.localeCompare(b.created_at) || compareIds(a.id, b.id));
}

// v1 ids grow with creation; UUIDv7 ids created within one millisecond carry no creation order (CR-2).
export function assertCreationOrderedIds(ids: readonly Id[], message: string): void {
  if (opaqueIds()) {
    assert.equal(new Set(ids).size, ids.length, `${message} (ids must be distinct)`);

    return;
  }
  assert.deepEqual(ids, [...ids].sort(compareIds), message);
}

// /__test/jobs ids are not among the public identifiers CR-2 enumerates, so either form is accepted after it.
export function assertTestEndpointId(value: unknown, what = 'id'): void {
  if (opaqueIds() && typeof value === 'string') return assertPublicId(value, what);
  assert.ok(Number.isSafeInteger(value) && (value as number) > 0, `${what} must be a positive integer, got ${JSON.stringify(value)}`);
}

function isIdKey(key: string): boolean {
  return key === 'id' || key.endsWith('_id') || key.endsWith('_ids');
}

// CR-2: every id and *_id is a UUIDv7 string; legacy_ids is the one place integers may remain.
export function assertOnlyUuids(value: unknown, where = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertOnlyUuids(v, `${where}[${i}]`));

    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    const path = `${where}.${k}`;
    if (k === 'legacy_ids') continue;
    if (isIdKey(k) && v !== null && (typeof v !== 'object' || Array.isArray(v))) {
      for (const one of Array.isArray(v) ? v : [v]) {
        assert.ok(typeof one === 'string' && UUIDV7_RE.test(one), `${path} must be a lowercase UUIDv7, got ${JSON.stringify(one)}`);
      }
      continue;
    }
    assertOnlyUuids(v, path);
  }
}
