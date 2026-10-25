import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod';

import { tsTypeOf } from './ts-type.ts';

const typeOf = (schema: z.ZodType): string => tsTypeOf(z.toJSONSchema(schema, { io: 'output' }) as never);

test('tsTypeOf writes the TypeScript type of a contract output schema', () => {
  assert.equal(typeOf(z.object({ label: z.string() })), '{ label: string }');
  assert.equal(
    typeOf(z.object({ id: z.string(), count: z.int(), done: z.boolean().optional() })),
    '{ id: string; count: number; done?: boolean }',
  );
  assert.equal(typeOf(z.object({ tags: z.array(z.string()) }).nullable()), '{ tags: string[] } | null');
  assert.equal(typeOf(z.array(z.union([z.string(), z.number()]))), '(string | number)[]');
  assert.equal(
    typeOf(z.array(z.object({ sku: z.string(), note: z.string().nullable() }))),
    '{ sku: string; note: string | null }[]',
  );
  assert.equal(typeOf(z.enum(['a', 'b'])), "'a' | 'b'");
  assert.equal(typeOf(z.object({})), 'Record<string, never>');
});
