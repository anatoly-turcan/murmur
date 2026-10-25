import assert from 'node:assert/strict';
import { test } from 'node:test';

import { etagOf } from '#lib/etag';

test('etagOf is a quoted 16-hex digest of the todo', () => {
  assert.match(etagOf({ id: 't1', title: 'milk', done: false }), /^"[0-9a-f]{16}"$/);
});
