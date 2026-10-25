import assert from 'node:assert/strict';
import type { ApiResponse, Json } from './client.ts';
import type { Id } from './ids.ts';

export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function describe(res: ApiResponse): string {
  return `${res.method} ${res.url} → ${res.status} ${res.text.slice(0, 600)}`;
}

export function expectStatus(res: ApiResponse, expected: number | readonly number[], note = ''): void {
  const allowed = typeof expected === 'number' ? [expected] : expected;
  if (!allowed.includes(res.status)) {
    assert.fail(`expected status ${allowed.join('|')}${note ? ` (${note})` : ''}, got ${describe(res)}`);
  }
}

export interface DetailMatch {
  path: string;
  code: string;
  [extra: string]: unknown;
}

function detailMatches(actual: Json, expected: DetailMatch): boolean {
  if (!actual || typeof actual !== 'object') return false;

  return Object.entries(expected).every(([k, v]) => {
    try {
      assert.deepEqual(actual[k], v);

      return true;
    } catch {
      return false;
    }
  });
}

export function expectError(
  res: ApiResponse,
  status: number,
  code: string,
  details?: DetailMatch | readonly DetailMatch[],
  opts: { exactDetails?: boolean } = {},
): void {
  expectStatus(res, status, code);
  const error = res.body?.error;
  assert.ok(error && typeof error === 'object', `expected {"error": {...}} body, got ${describe(res)}`);
  assert.equal(error.code, code, `error.code mismatch: ${describe(res)}`);
  assert.equal(typeof error.message, 'string', `error.message must be a string: ${describe(res)}`);
  assert.ok(error.message.length > 0, `error.message must be non-empty: ${describe(res)}`);
  if (details === undefined) return;
  const expected = Array.isArray(details) ? details : [details as DetailMatch];
  assert.ok(Array.isArray(error.details), `error.details must be an array: ${describe(res)}`);
  for (const d of error.details) {
    assert.equal(typeof d.path, 'string', `every detail needs a string path: ${describe(res)}`);
    assert.equal(typeof d.code, 'string', `every detail needs a string code: ${describe(res)}`);
  }
  for (const want of expected) {
    assert.ok(
      error.details.some((d: Json) => detailMatches(d, want)),
      `missing detail ${JSON.stringify(want)}: ${describe(res)}`,
    );
  }
  if (opts.exactDetails) {
    assert.equal(error.details.length, expected.length, `expected exactly ${expected.length} details: ${describe(res)}`);
  }
}

export function expectValidation(res: ApiResponse, path: string, code: string, extra: Record<string, unknown> = {}): void {
  expectError(res, 422, 'validation_failed', { path, code, ...extra });
}

const TIMESTAMP_KEYS = new Set(['now']);

export function assertTimestamps(value: Json, where = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertTimestamps(v, `${where}[${i}]`));

    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    const path = `${where}.${k}`;
    if ((k.endsWith('_at') || TIMESTAMP_KEYS.has(k)) && v !== null) {
      assert.equal(typeof v, 'string', `${path} must be a timestamp string, got ${JSON.stringify(v)}`);
      assert.match(v as string, TIMESTAMP_RE, `${path} must be UTC with milliseconds and Z, got ${v}`);
    }
    assertTimestamps(v, path);
  }
}

export function assertMinorStrings(value: Json, where = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertMinorStrings(v, `${where}[${i}]`));

    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    const path = `${where}.${k}`;
    if (k.endsWith('_minor')) {
      assert.equal(typeof v, 'string', `${path} must be a string of digits, got ${JSON.stringify(v)}`);
      assert.match(v as string, /^[0-9]+$/, `${path} must be decimal digits, got ${v}`);
    }
    assertMinorStrings(v, path);
  }
}

export function expectRateLimitHeaders(res: ApiResponse): { limit: number; remaining: number; reset: number } {
  const read = (name: string): number => {
    const raw = res.headers.get(name);
    assert.ok(raw !== null, `missing ${name} header on ${describe(res)}`);
    assert.match(raw, /^\d+$/, `${name} must be whole number, got ${raw}`);

    return Number(raw);
  };

  return { limit: read('ratelimit-limit'), remaining: read('ratelimit-remaining'), reset: read('ratelimit-reset') };
}

export function assertUnique(values: readonly unknown[], what = 'values'): void {
  const seen = new Set<unknown>();
  const dups = values.filter((v) => (seen.has(v) ? true : (seen.add(v), false)));
  assert.deepEqual(dups, [], `duplicate ${what}: ${JSON.stringify(dups)}`);
}

export function ids(items: readonly Json[]): Id[] {
  return items.map((i) => i.id);
}

export function countBy<T>(items: readonly T[], key: (item: T) => string | number): Map<string | number, number> {
  const out = new Map<string | number, number>();
  for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + 1);

  return out;
}
