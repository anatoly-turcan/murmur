import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineCapability, type HandleOf } from 'murmur';
import { z } from 'zod';

test('defineCapability returns the definition unchanged', () => {
  const def = {
    name: 'postgres',
    config: z.object({ url: z.string() }),
    start: () => ({ query: async () => [], transaction: async () => ({}) as never }),
  } as const;
  assert.equal(defineCapability(def), def);
});

test('the token carries the handle type that start returns', () => {
  const token = defineCapability({ name: 'pool', start: () => ({ pool: 'raw' }) });
  const handle: HandleOf<typeof token> = { pool: 'x' };

  assert.equal(token.name, 'pool');
  assert.equal(handle.pool, 'x');
});
