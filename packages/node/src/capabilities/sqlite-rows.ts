import type { ModelClass } from 'murmur';
import type { z } from 'zod';

import { unwrapped } from '../zod-unwrap.ts';
import { SqliteError } from './sqlite-error.ts';

type Call = 'rows' | 'row';
export type Row = Readonly<Record<string, unknown>>;

const JSON_TYPES: ReadonlySet<string> = new Set(['array', 'tuple', 'object', 'record']);

function shapeOf(model: ModelClass, call: Call): Readonly<Record<string, z.ZodType>> {
  const shape: unknown = Reflect.get(model.schema, 'shape');
  if (typeof shape !== 'object' || shape === null) {
    throw new SqliteError(`db.${call}(${model.name}): expected a Model class, like db.${call}(Todo, sql)`);
  }

  return shape as Record<string, z.ZodType>;
}

function decodeValue(field: z.ZodType, value: unknown, where: () => string): unknown {
  const type = unwrapped(field).def.type;
  if (type === 'boolean' && (value === 0 || value === 1 || value === 0n || value === 1n)) {
    return Number(value) === 1;
  }

  if (!JSON_TYPES.has(type) || typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new SqliteError(
      `${where()} holds TEXT that is not JSON; store JSON.stringify(value) for an array, object or record field`,
    );
  }
}

function decodeColumns(model: ModelClass, call: Call, row: Row): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(shapeOf(model, call))) {
    const where = () => `db.${call}(${model.name}): column "${name}"`;
    if (!Object.hasOwn(row, name)) {
      throw new SqliteError(
        `${where()} is missing from the result; select every field of the Model, aliasing in SQL (SELECT <column> AS ${name})`,
      );
    }

    decoded[name] = decodeValue(field, row[name], where);
  }

  return decoded;
}

export function decodeRow<M extends ModelClass>(model: M, call: Call, row: Row): InstanceType<M> {
  const parsed = model.schema.safeParse(decodeColumns(model, call, row));
  if (parsed.success) {
    return parsed.data as InstanceType<M>;
  }

  const [issue] = parsed.error.issues;
  const column = issue?.path[0];
  const subject = column === undefined ? 'the row' : `column "${String(column)}"`;

  throw new SqliteError(
    `db.${call}(${model.name}): ${subject} does not fit the Model: ${issue?.message ?? 'invalid'} (a boolean field reads INTEGER 0/1, an array/object/record field reads JSON TEXT)`,
  );
}
