import { z } from 'zod';

import { isZodSchema, toObjectSchema, type ObjectSpec, type ParsedOf } from './schema.ts';
import type { Widest } from './widest.ts';

export interface ModelClass<T = Widest> {
  new (data: T): T;
  readonly kind: 'model';
  readonly schema: z.ZodType<T>;
  nullable<M extends ModelClass>(this: M): z.ZodType<InstanceType<M> | null>;
  array<M extends ModelClass>(this: M): z.ZodType<InstanceType<M>[]>;
}

export function Model<S extends ObjectSpec>(spec: S): ModelClass<ParsedOf<S>> {
  const schema = toObjectSchema(spec, 'Model()');

  return class {
    static readonly kind = 'model';
    static readonly schema = schema;

    static nullable(): z.ZodType {
      return schema.nullable();
    }

    static array(): z.ZodType {
      return z.array(schema);
    }

    constructor(data: object) {
      Object.assign(this, data);
    }
  } as never;
}

export function isModel(value: unknown): value is ModelClass {
  return (
    typeof value === 'function' &&
    Reflect.get(value, 'kind') === 'model' &&
    isZodSchema(Reflect.get(value, 'schema'))
  );
}
