import assert from 'node:assert/strict';
import { test } from 'node:test';

import { guardOrderProblem, metaKeyProblem, type GuardShape } from 'murmur';

const authenticate: GuardShape = {
  id: 'a.Authenticate',
  label: 'Authenticate',
  after: [],
  optional: [],
  metaKeys: [],
};
const resolve: GuardShape = {
  id: 'a.ResolveTarget',
  label: 'ResolveTarget',
  after: [authenticate],
  optional: [],
  metaKeys: ['target', 'role'],
};

test('guardOrderProblem names the reorder and the skip forms', () => {
  assert.equal(guardOrderProblem('GET /x', [authenticate, resolve], []), undefined);
  assert.equal(
    guardOrderProblem('GET /x', [resolve, authenticate], []),
    "route GET /x: ResolveTarget runs before Authenticate, which ResolveTarget lists in `after`; reorder the token's guards, or make Authenticate `optional` on ResolveTarget",
  );
  assert.equal(
    guardOrderProblem('GET /x', [resolve], ['a.Authenticate']),
    "route GET /x skips Authenticate but keeps ResolveTarget, whose `after` names Authenticate; skip ResolveTarget too, or declare Authenticate in ResolveTarget's `optional`",
  );
});

test('metaKeyProblem lists the keys the kept guards accept', () => {
  assert.equal(metaKeyProblem('GET /x', [authenticate, resolve], ['role']), undefined);
  assert.equal(
    metaKeyProblem('GET /x', [authenticate, resolve], ['rol']),
    'route GET /x: meta key `rol` is read by no kept guard; the kept guards accept target, role',
  );
});
