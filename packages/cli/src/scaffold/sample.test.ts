import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod';

import { sampleOf } from './sample.ts';

const sample = (schema: z.ZodType): unknown => sampleOf(z.toJSONSchema(schema) as never);

test('sampleOf builds a payload the contract schema accepts', () => {
  const schema = z.object({
    id: z.uuid(),
    email: z.email(),
    at: z.iso.datetime(),
    day: z.iso.date(),
    link: z.url(),
    title: z.string().min(12).max(20),
    short: z.string().max(3),
    count: z.int().positive(),
    price: z.number().min(5),
    below: z.number().max(-2),
    under: z.int().lt(0),
    kind: z.enum(['a', 'b']),
    tags: z.array(z.string()),
    pair: z.array(z.int()).min(2),
    note: z.string().optional(),
  });
  assert.deepEqual(schema.safeParse(sample(schema)).error?.issues ?? [], []);
});

test('sampleOf picks a meaningful value per type and recurses into nested objects', () => {
  const schema = z.object({
    title: z.string(),
    count: z.number(),
    n: z.int(),
    done: z.boolean(),
    tags: z.array(z.string()),
    owner: z.object({ name: z.string(), age: z.int(), roles: z.array(z.object({ name: z.string() })) }),
    note: z.string().nullable(),
    kind: z.literal('todo'),
  });
  assert.deepEqual(sample(schema), {
    title: 'example',
    count: 1,
    n: 1,
    done: true,
    tags: [],
    owner: { name: 'example', age: 1, roles: [] },
    note: 'example',
    kind: 'todo',
  });
});

test('sampleOf fills an array up to its minimum length with item samples', () => {
  assert.deepEqual(sample(z.array(z.object({ id: z.string() })).min(2)), [
    { id: 'example' },
    { id: 'example' },
  ]);
});
