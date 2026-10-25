import type { z } from 'zod';

const WRAPPERS: ReadonlySet<string> = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'catch',
  'readonly',
]);

export function unwrapped(schema: z.ZodType): z.ZodType {
  const inner: unknown = Reflect.get(schema.def, 'innerType');

  return WRAPPERS.has(schema.def.type) && inner !== undefined ? unwrapped(inner as z.ZodType) : schema;
}
