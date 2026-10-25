import type { LegacyKind } from '../ids/legacy.ts';
import { legacyInteger, normalizeUuid, type Id } from '../ids/uuid.ts';
import { nfcTrim, codePoints } from '../text/normalize.ts';
import { isRealDate, parseTimestamp } from '../time/format.ts';
import { invalidQuery } from './errors.ts';

export const BAD: unique symbol = Symbol('bad');
type Bad = typeof BAD;

export interface QueryField<T> {
  repeatable?: boolean;
  required?: boolean;
  default?: T;
  parse(values: string[]): T | Bad;
}

export type QuerySpec = Record<string, QueryField<unknown>>;
export type QueryValues = Record<string, unknown>;

const INT_RE = /^(0|-?[1-9][0-9]*)$/;
const LEGACY: unique symbol = Symbol('legacy');

export interface LegacyRef {
  [LEGACY]: true;
  legacyId: number;
  kinds: readonly LegacyKind[];
}

export function isLegacyRef(value: unknown): value is LegacyRef {
  return typeof value === 'object' && value !== null && LEGACY in value;
}

function single<T>(parse: (raw: string) => T | Bad, extra: Partial<QueryField<T>> = {}): QueryField<T> {
  return { ...extra, parse: (values) => parse(values[0]) };
}

function parseIntIn(raw: string, min: number, max: number): number | Bad {
  if (!INT_RE.test(raw)) return BAD;
  const n = Number(raw);

  return n >= min && n <= max ? n : BAD;
}

function parseId(raw: string, kinds: readonly LegacyKind[]): Id | LegacyRef | Bad {
  const uuid = normalizeUuid(raw);
  if (uuid !== null) return uuid;
  const legacyId = legacyInteger(raw);

  return legacyId === null ? BAD : { [LEGACY]: true, legacyId, kinds };
}

export const q = {
  int: (min: number, max: number, def?: number): QueryField<number> => single((raw) => parseIntIn(raw, min, max), { default: def }),
  bool: (def?: boolean): QueryField<boolean> =>
    single((raw) => (raw === 'true' ? true : raw === 'false' ? false : BAD), { default: def }),
  enumOne: <T extends string>(set: readonly T[], def?: T): QueryField<T> =>
    single((raw) => (set.includes(raw as T) ? (raw as T) : BAD), { default: def }),
  enumList: <T extends string>(set: readonly T[]): QueryField<T[]> =>
    single((raw) => {
      const items = raw.split(',');

      return items.length > 0 && items.every((i) => set.includes(i as T)) ? [...new Set(items as T[])].sort() : BAD;
    }),
  date: (): QueryField<string> => single((raw) => (isRealDate(raw) ? raw : BAD)),
  timestamp: (): QueryField<number> => single((raw) => parseTimestamp(raw) ?? BAD),
  id: (...kinds: LegacyKind[]): QueryField<Id | LegacyRef> => single((raw) => parseId(raw, kinds)),
  idOr: <T extends string>(words: readonly T[], kind: LegacyKind): QueryField<Id | LegacyRef | T> =>
    single((raw) => (words.includes(raw as T) ? (raw as T) : parseId(raw, [kind]))),
  text: (min: number, max: number, opts: { required?: boolean } = {}): QueryField<string> =>
    single((raw) => {
      const text = nfcTrim(raw);
      const n = codePoints(text);

      return n >= min && n <= max ? text : BAD;
    }, opts),
  raw: (): QueryField<string> => single((raw) => raw),
  repeat: (min: number, max: number): QueryField<string[]> => ({
    repeatable: true,
    parse: (values) => {
      const out = values.map((v) => nfcTrim(v));

      return out.every((v) => codePoints(v) >= min && codePoints(v) <= max) ? out : BAD;
    },
  }),
};

export const LIST_QUERY: QuerySpec = { limit: q.int(1, 100, 20), cursor: q.raw() };

function grouped(params: URLSearchParams): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, v] of params) out.set(k, [...(out.get(k) ?? []), v]);

  return out;
}

function parseOne(name: string, field: QueryField<unknown> | undefined, values: string[]): unknown {
  if (!field) throw invalidQuery(`Unknown query parameter: ${name}.`);
  if (values.length > 1 && !field.repeatable) throw invalidQuery(`Query parameter ${name} may appear only once.`);
  const parsed = field.parse(values);
  if (parsed === BAD) throw invalidQuery(`Invalid value for query parameter ${name}.`);

  return parsed;
}

export function parseQuery(params: URLSearchParams, spec: QuerySpec): QueryValues {
  const values: QueryValues = {};
  for (const [name, raw] of grouped(params)) values[name] = parseOne(name, spec[name], raw);
  for (const [name, field] of Object.entries(spec)) {
    if (name in values) continue;
    if (field.required) throw invalidQuery(`Query parameter ${name} is required.`);
    if (field.default !== undefined) values[name] = field.default;
  }

  return values;
}

// A legacy integer filter over several object kinds resolves to every UUID it named, so it binds as a JSON list.
export function idListParam(value: unknown): string | null {
  if (value === undefined) return null;

  return JSON.stringify(Array.isArray(value) ? value : [value]);
}
