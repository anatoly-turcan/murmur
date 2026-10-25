import { MurmurError } from 'murmur';
import type { z } from 'zod';

import { unwrapped } from '../../zod-unwrap.ts';
import { coerceStrings, type Coerced, type ZodIssue } from './coerce.ts';
import type { InputPart } from './errors.ts';
import { definedParams, jsonBody, objectOf, type InputSource, type PartSpec } from './input.ts';
import { inputError } from './issues.ts';

export interface ReadSpec {
  readonly params?: PartSpec;
  readonly query?: PartSpec;
  readonly headers?: PartSpec;
  readonly body?: PartSpec;
}

type Parsed<S> = S extends z.ZodObject
  ? z.output<S>
  : S extends z.ZodRawShape
    ? z.output<z.ZodObject<S>>
    : never;

type AbsentAsNull<O> = {
  readonly [K in keyof O]-?: {} extends Pick<O, K> ? Exclude<O[K], undefined> | null : O[K];
};

export type ReadResult<S extends ReadSpec> = {
  readonly [K in keyof S]-?: K extends 'headers' ? AbsentAsNull<Parsed<S[K]>> : Parsed<S[K]>;
};

type Part = keyof ReadSpec;

const PART_ORDER: readonly Part[] = ['params', 'query', 'headers', 'body'];

function isListField(schema: z.ZodType | undefined): boolean {
  return schema !== undefined && unwrapped(schema).def.type === 'array';
}

function repeatedIssue(key: string): ZodIssue {
  return {
    code: 'custom',
    path: [key],
    message: `"${key}" may appear only once`,
    params: { code: 'repeated_key' },
  };
}

function queryValues(
  schema: z.ZodObject,
  query: URLSearchParams,
): { raw: Record<string, unknown>; repeated: ZodIssue[] } {
  const raw: Record<string, unknown> = {};
  const repeated: ZodIssue[] = [];

  for (const key of new Set(query.keys())) {
    const values = query.getAll(key);
    if (isListField(schema.shape[key])) {
      raw[key] = values;
    } else if (values.length > 1) {
      repeated.push(repeatedIssue(key));
    } else {
      raw[key] = values[0];
    }
  }

  return { raw, repeated };
}

function readQuery(schema: z.ZodObject, source: InputSource): Promise<Coerced> | Coerced {
  const { raw, repeated } = queryValues(schema, source.query);
  if (repeated.length > 0) {
    return { issues: repeated };
  }

  return coerceStrings(schema.strict(), raw);
}

function absentHeader(schema: z.ZodType): undefined | null {
  return schema.safeParse(undefined).success ? undefined : null;
}

function lowerCaseKeys(schema: z.ZodObject): string[] {
  const keys = Object.keys(schema.shape);
  const mixed = keys.find((key) => key !== key.toLowerCase());

  if (mixed !== undefined) {
    throw new MurmurError(
      `req.read header keys are lower-case: use '${mixed.toLowerCase()}', not '${mixed}'`,
      {
        code: 'header-key-case',
        retryable: false,
      },
    );
  }

  return keys;
}

async function readHeaders(schema: z.ZodObject, source: InputSource): Promise<Coerced> {
  const keys = lowerCaseKeys(schema);
  const raw = Object.fromEntries(
    keys.map((key) => [key, source.headers.get(key) ?? absentHeader(schema.shape[key] as z.ZodType)]),
  );
  const read = await coerceStrings(schema, raw);

  if (read.issues !== undefined) {
    return read;
  }

  const value = read.value as Record<string, unknown>;

  return {
    value: {
      ...value,
      ...Object.fromEntries(keys.filter((key) => value[key] === undefined).map((key) => [key, null])),
    },
  };
}

async function readBody(schema: z.ZodObject, source: InputSource): Promise<Coerced> {
  const result = await schema.safeParseAsync(await jsonBody(source));

  return result.success ? { value: result.data } : { issues: result.error.issues };
}

function readPart(part: Part, schema: z.ZodObject, source: InputSource): Promise<Coerced> | Coerced {
  switch (part) {
    case 'params':
      return coerceStrings(schema, definedParams(source.params));
    case 'query':
      return readQuery(schema, source);
    case 'headers':
      return readHeaders(schema, source);
    case 'body':
      return readBody(schema, source);
  }
}

async function readFrom(
  parts: readonly Part[],
  spec: ReadSpec,
  source: InputSource,
  out: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [part, ...rest] = parts;
  if (part === undefined) {
    return out;
  }

  const given = spec[part];
  if (given === undefined) {
    return readFrom(rest, spec, source, out);
  }

  const read = await readPart(part, objectOf(given), source);
  if (read.issues !== undefined) {
    throw inputError(part satisfies InputPart, read.issues);
  }

  return readFrom(rest, spec, source, { ...out, [part]: read.value });
}

export async function readParts<S extends ReadSpec>(spec: S, source: InputSource): Promise<ReadResult<S>> {
  return (await readFrom(PART_ORDER, spec, source, {})) as ReadResult<S>;
}
