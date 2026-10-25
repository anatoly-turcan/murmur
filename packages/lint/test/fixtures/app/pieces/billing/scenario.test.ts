import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTestRuntime } from '@murmur/node/testing';

test('billing subtree', () => {
  assert.equal(typeof createTestRuntime, 'function');
});
