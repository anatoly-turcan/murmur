import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineApp } from '@murmur/node';

import { memoryApp } from './helpers.ts';

test('defineApp is the identity', () => {
  const app = { name: 'x', transport: memoryApp('x').app.transport };
  assert.equal(defineApp(app), app);
});
