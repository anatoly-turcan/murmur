import { normalizeUuid, type Id } from '../ids/uuid.ts';
import { AMOUNT_RE, decimalsOf, fractionDigits, isCurrency, parseMinor } from '../money/money.ts';
import { emailProblem } from '../text/email.ts';
import { codePoints, nfcTrim } from '../text/normalize.ts';
import { slugProblem } from '../text/slug.ts';
import { isDateShaped, isRealDate } from '../time/format.ts';
import { isValidTimezone } from '../time/zones.ts';
import { detail, type Detail } from './errors.ts';

export const INVALID: unique symbol = Symbol('invalid');
export type Invalid = typeof INVALID;

export interface Field<T> {
  nullable: boolean;
  parse(value: unknown, path: string, details: Detail[]): T | Invalid;
}

export type FieldSpecs = Record<string, Field<unknown>>;

export type ValuesOf<S extends FieldSpecs> = { [K in keyof S]?: S[K] extends Field<infer T> ? T : never };

export interface BudgetInput {
  currency: string;
  minor: bigint;
}

function field<T>(parse: Field<T>['parse']): Field<T> {
  return { nullable: false, parse };
}

function fail(details: Detail[], path: string, code: string): Invalid {
  details.push(detail(path, code));

  return INVALID;
}

export function nullable<T>(inner: Field<T>): Field<T | null> {
  return { nullable: true, parse: (value, path, details) => (value === null ? null : inner.parse(value, path, details)) };
}

export function str(opts: { min?: number; max: number }): Field<string> {
  const min = opts.min ?? 1;

  return field((value, path, details) => {
    if (typeof value !== 'string') return fail(details, path, 'invalid_type');
    const text = nfcTrim(value);
    const length = codePoints(text);
    if (length < min) return fail(details, path, 'too_short');
    if (length > opts.max) return fail(details, path, 'too_long');

    return text;
  });
}

export function oneOf<T extends string>(values: readonly T[]): Field<T> {
  return field((value, path, details) => {
    if (typeof value !== 'string') return fail(details, path, 'invalid_type');
    const text = nfcTrim(value) as T;

    return values.includes(text) ? text : fail(details, path, 'invalid_enum');
  });
}

export function int(opts: { min: number; max: number }): Field<number> {
  return field((value, path, details) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return fail(details, path, 'invalid_type');
    if (value < opts.min || value > opts.max) return fail(details, path, 'out_of_range');

    return value;
  });
}

export function bool(): Field<boolean> {
  return field((value, path, details) => (typeof value === 'boolean' ? value : fail(details, path, 'invalid_type')));
}

export function id(): Field<Id> {
  return field((value, path, details) => {
    if (typeof value === 'number' && Number.isInteger(value)) return fail(details, path, 'legacy_id_not_allowed');
    if (typeof value !== 'string') return fail(details, path, 'invalid_type');

    return normalizeUuid(value) ?? fail(details, path, 'invalid_format');
  });
}

export function date(): Field<string> {
  return field((value, path, details) => {
    if (typeof value !== 'string') return fail(details, path, 'invalid_type');
    const text = nfcTrim(value);
    if (!isDateShaped(text)) return fail(details, path, 'invalid_format');

    return isRealDate(text) ? text : fail(details, path, 'invalid_date');
  });
}

function refine<T>(base: Field<T>, check: (value: T) => string | null): Field<T> {
  return field((value, path, details) => {
    const parsed = base.parse(value, path, details);
    if (parsed === INVALID) return INVALID;
    const problem = check(parsed);

    return problem ? fail(details, path, problem) : parsed;
  });
}

export function email(): Field<string> {
  return refine(str({ min: 1, max: Number.MAX_SAFE_INTEGER }), emailProblem);
}

export function slug(): Field<string> {
  return refine(str({ min: 1, max: Number.MAX_SAFE_INTEGER }), slugProblem);
}

export function timezone(): Field<string> {
  return refine(str({ min: 1, max: 200 }), (tz) => (isValidTimezone(tz) ? null : 'invalid_timezone'));
}

export function custom<T>(parse: Field<T>['parse']): Field<T> {
  return field(parse);
}

interface ListOptions<T> {
  min?: number;
  max?: number;
  uniqueBy?: (item: T) => string;
}

function listItems<T>(items: unknown[], item: Field<T>, path: string, details: Detail[]): (T | Invalid)[] {
  return items.map((value, i) => item.parse(value, `${path}[${i}]`, details));
}

function duplicates<T>(parsed: (T | Invalid)[], key: (item: T) => string, path: string, details: Detail[]): boolean {
  const seen = new Set<string>();
  let found = false;
  parsed.forEach((value, i) => {
    if (value === INVALID) return;
    const k = key(value as T);
    if (seen.has(k)) {
      details.push(detail(`${path}[${i}]`, 'duplicate'));
      found = true;
    }
    seen.add(k);
  });

  return found;
}

export function list<T>(item: Field<T>, opts: ListOptions<T> = {}): Field<T[]> {
  return field((value, path, details) => {
    if (!Array.isArray(value)) return fail(details, path, 'invalid_type');
    const before = details.length;
    if (value.length > (opts.max ?? Infinity)) details.push(detail(path, 'too_many_items'));
    if (value.length < (opts.min ?? 0)) details.push(detail(path, 'too_short'));
    const parsed = listItems(value, item, path, details);
    if (opts.uniqueBy) duplicates(parsed, opts.uniqueBy, path, details);

    return details.length > before ? INVALID : (parsed as T[]);
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function budgetCurrency(raw: unknown, path: string, details: Detail[]): string | Invalid {
  if (raw === undefined) return fail(details, `${path}.currency`, 'required');
  if (typeof raw !== 'string') return fail(details, `${path}.currency`, 'invalid_type');
  const code = nfcTrim(raw);

  return isCurrency(code) ? code : fail(details, `${path}.currency`, 'unsupported_currency');
}

function budgetAmount(raw: unknown, path: string, details: Detail[]): string | Invalid {
  if (raw === undefined) return fail(details, `${path}.amount`, 'required');
  if (typeof raw !== 'string') return fail(details, `${path}.amount`, 'invalid_type');
  const amount = nfcTrim(raw);

  return AMOUNT_RE.test(amount) ? amount : fail(details, `${path}.amount`, 'invalid_format');
}

export function money(): Field<BudgetInput> {
  return field((value, path, details) => {
    if (!isPlainObject(value)) return fail(details, path, 'invalid_type');
    const before = details.length;
    for (const key of Object.keys(value)) {
      if (key !== 'currency' && key !== 'amount') details.push(detail(`${path}.${key}`, 'unknown_field'));
    }
    const currency = budgetCurrency(value.currency, path, details);
    const amount = budgetAmount(value.amount, path, details);
    if (currency === INVALID || amount === INVALID) return INVALID;
    if (fractionDigits(amount) > decimalsOf(currency)) return fail(details, `${path}.amount`, 'too_many_decimals');

    return details.length > before ? INVALID : { currency, minor: parseMinor(amount, decimalsOf(currency)) };
  });
}

export interface ValidateOptions<S> {
  required?: readonly (keyof S & string)[];
}

function parseField(spec: Field<unknown>, value: unknown, path: string, details: Detail[]): unknown {
  if (value === null && !spec.nullable) return fail(details, path, 'not_nullable');

  return spec.parse(value, path, details);
}

export function validateBody<S extends FieldSpecs>(
  body: Record<string, unknown>,
  specs: S,
  opts: ValidateOptions<S> = {},
): { values: ValuesOf<S>; details: Detail[] } {
  const details: Detail[] = [];
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const spec = specs[key];
    if (!spec) {
      details.push(detail(key, 'unknown_field'));
      continue;
    }
    const parsed = parseField(spec, value, key, details);
    if (parsed !== INVALID) values[key] = parsed;
  }
  for (const key of opts.required ?? []) {
    if (!(key in body)) details.push(detail(key, 'required'));
  }

  return { values: values as ValuesOf<S>, details };
}

export function has<T extends object>(values: T, key: keyof T): boolean {
  return Object.hasOwn(values, key);
}
