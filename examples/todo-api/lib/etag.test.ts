import assert from 'node:assert/strict';
import { test } from 'node:test';

import { etagOf } from '#lib/etag';

test('etagOf is a quoted 16-hex digest that changes with the todo', () => {
  const milk = { id: 't1', title: 'milk', done: false };

  assert.match(etagOf(milk), /^"[0-9a-f]{16}"$/);
  assert.equal(etagOf({ ...milk }), etagOf(milk));
  assert.notEqual(etagOf({ ...milk, done: true }), etagOf(milk));
});
