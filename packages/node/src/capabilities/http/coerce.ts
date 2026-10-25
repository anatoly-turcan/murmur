import type { z } from 'zod';

export interface PayloadParts {
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: Readonly<Record<string, unknown>>;
}

export type ZodIssue = z.core.$ZodIssue;

export type Coerced =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly issues: readonly ZodIssue[] };

const UNDECODABLE = Symbol('undecodable');

function decodeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return UNDECODABLE;
  }
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => (typeof item === 'string' ? decodeValue(item) : item));
  }

  if (typeof value !== 'string') {
    return UNDECODABLE;
  }

  const decoded = decodeJson(value);

  return decoded === UNDECODABLE ? value : decoded;
}

function topKey(issue: ZodIssue): PropertyKey | undefined {
  return issue.path[0];
}

function decodeFailing(
  raw: Readonly<Record<string, unknown>>,
  issues: readonly ZodIssue[],
  decodable: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const failing = new Set(issues.map(topKey).filter((key): key is string => typeof key === 'string'));
  const decoded = [...failing]
    .filter((key) => decodable.has(key))
    .map((key): [string, unknown] => [key, decodeValue(raw[key])])
    .filter(([key, value]) => value !== UNDECODABLE && value !== raw[key]);

  return decoded.length === 0 ? undefined : { ...raw, ...Object.fromEntries(decoded) };
}

async function parsed(schema: z.ZodType, value: unknown): Promise<Coerced> {
  const result = await schema.safeParseAsync(value);

  return result.success ? { value: result.data } : { issues: result.error.issues };
}

export async function coerceStrings(
  schema: z.ZodType,
  raw: Readonly<Record<string, unknown>>,
  decodable: ReadonlySet<string> = new Set(Object.keys(raw)),
): Promise<Coerced> {
  const first = await parsed(schema, raw);
  if (first.issues === undefined) {
    return first;
  }

  const retry = decodeFailing(raw, first.issues, decodable);
  if (retry === undefined) {
    return first;
  }

  return parsed(schema, retry);
}

function stringKeys(parts: PayloadParts): Set<string> {
  return new Set(
    [...Object.keys(parts.params), ...Object.keys(parts.query)].filter((key) => !(key in parts.body)),
  );
}

export function coercePayload(schema: z.ZodType, parts: PayloadParts): Promise<Coerced> {
  return coerceStrings(schema, { ...parts.params, ...parts.query, ...parts.body }, stringKeys(parts));
}
