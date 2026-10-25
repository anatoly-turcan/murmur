import { z } from 'zod';

import { ContractViolationError, MurmurError, type SchemaIssue, type ViolationSide } from './errors.ts';

export type Schema = z.ZodType;
export type Shape = z.ZodRawShape;
export type ObjectSpec = Shape | z.ZodObject;
export type ObjectOf<S> = S extends z.ZodObject ? S : S extends Shape ? z.ZodObject<S> : never;
export type ParsedOf<S> = z.output<ObjectOf<S>>;
export type UnparsedOf<S> = z.input<ObjectOf<S>>;

interface ZodInternals {
  readonly def: { readonly type: string };
}

export function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_zod' in value &&
    typeof Reflect.get(value, 'safeParse') === 'function'
  );
}

export function isZodObject(value: unknown): value is z.ZodObject {
  return isZodSchema(value) && (Reflect.get(value, '_zod') as ZodInternals).def.type === 'object';
}

export function isShape(value: unknown): value is Shape {
  return (
    typeof value === 'object' &&
    value !== null &&
    !isZodSchema(value) &&
    Object.values(value).every((field) => isZodSchema(field))
  );
}

export function toObjectSchema(spec: unknown, where: string): z.ZodObject {
  if (isZodObject(spec)) {
    return spec;
  }

  if (isShape(spec)) {
    return z.object(spec);
  }

  throw invalidSchema(`${where}: expected a zod object or a shape of zod schemas`);
}

export function invalidSchema(message: string): MurmurError {
  return new MurmurError(message, { code: 'invalid-schema', retryable: false });
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

export type Parsed =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly issues: readonly SchemaIssue[] };

function issuesOf(error: z.ZodError): SchemaIssue[] {
  return error.issues.map((issue) => ({ message: issue.message, path: issue.path }));
}

export async function parseSchema(schema: Schema, value: unknown): Promise<Parsed> {
  const result = await schema.safeParseAsync(value);

  return result.success ? { value: result.data } : { issues: issuesOf(result.error) };
}

export function parseSchemaSync(schema: Schema, value: unknown): Parsed {
  const result = schema.safeParse(value);

  return result.success ? { value: result.data } : { issues: issuesOf(result.error) };
}

export async function parseWire(
  contract: string,
  side: ViolationSide,
  schema: Schema,
  value: unknown,
): Promise<unknown> {
  const parsed = await parseSchema(schema, value);
  if (parsed.issues !== undefined) {
    throw new ContractViolationError(contract, side, parsed.issues);
  }

  return parsed.value;
}
