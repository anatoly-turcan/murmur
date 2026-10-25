import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_ERROR_STATUS } from '../../node/src/capabilities/http/errors.ts';
import { DEFAULT_ERRORS } from '../src/analysis/context-serves.ts';

function asRecord(
  rows: readonly { name: string; status: number; code: string }[],
): Record<string, { status: number; code: string }> {
  return Object.fromEntries(rows.map((row) => [row.name, { status: row.status, code: row.code }]));
}

test("the ctx error table matches the http capability's default error statuses", () => {
  assert.deepEqual(asRecord(DEFAULT_ERRORS), DEFAULT_ERROR_STATUS);
});
