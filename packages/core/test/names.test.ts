import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isInternal, matchPattern, MurmurError, validateName, validatePieceId } from 'murmur';

import { isReply, PATTERN_CACHE_LIMIT, patternCacheSize } from '../src/model/names.ts';

test('validateName accepts event, internal and reply names', () => {
  for (const name of [
    'billing.invoice',
    'billing.invoice.created',
    'notify.send-email',
    '$sys.log',
    '$sys.delivery.acked',
    '$reply.1f9a2b3c',
  ]) {
    assert.doesNotThrow(() => validateName(name), name);
  }
});

test('validateName rejects names outside the grammar', () => {
  const bad = [
    'billing',
    'Billing.invoice',
    'billing..invoice',
    '1billing.x',
    'billing.-x',
    '$foo.bar',
    '$sys',
    '$reply.ABCDEFGH',
    '$reply.1234567',
    'a.b c',
    `a.${'b'.repeat(254)}`,
  ];

  for (const name of bad) {
    assert.throws(() => validateName(name), MurmurError, name);
  }
});

test('validatePieceId accepts folder paths and rejects anything else', () => {
  for (const id of ['billing', 'billing/invoice', 'billing/sim/rates', 'notify/send-email']) {
    assert.doesNotThrow(() => validatePieceId(id), id);
  }

  for (const id of ['', 'Billing', 'billing/', '/billing', 'billing//x', 'billing.invoice', 'a/1b']) {
    assert.throws(() => validatePieceId(id), MurmurError, id);
  }
});

test('matchPattern follows AMQP topic semantics', () => {
  const cases: [string, string, boolean][] = [
    ['billing.invoice.created', 'billing.invoice.created', true],
    ['billing.invoice.created', 'billing.invoice.voided', false],
    ['billing.*.created', 'billing.invoice.created', true],
    ['billing.*', 'billing.invoice.created', false],
    ['billing.#', 'billing.invoice.created', true],
    ['billing.#', 'billing', true],
    ['#', 'billing.invoice', true],
    ['#', '$sys.log', true],
    ['#.created', 'billing.invoice.created', true],
    ['#.created', 'created', true],
    ['billing.#.created', 'billing.created', true],
    ['billing.#.created', 'billing.a.b.created', true],
    ['$sys.*', '$sys.log', true],
    ['$sys.#', 'billing.log', false],
    ['a.b', 'a.bc', false],
    ['a.b', 'axb', false],
  ];

  for (const [pattern, name, expected] of cases) {
    assert.equal(matchPattern(pattern, name), expected, `${pattern} ~ ${name}`);
  }
});

test('matchPattern bounds its compiled-pattern cache and still matches evicted patterns', () => {
  for (let i = 0; i < PATTERN_CACHE_LIMIT * 3; i += 1) {
    assert.equal(matchPattern(`p${i}.*`, `p${i}.x`), true);
    assert.equal(matchPattern(`p${i}.*`, `q${i}.x`), false);
  }

  assert.equal(patternCacheSize(), PATTERN_CACHE_LIMIT);
  assert.equal(matchPattern('p0.*', 'p0.x'), true);
  assert.equal(matchPattern('p0.*', 'p0.x.y'), false);
});

test('isInternal and isReply classify reserved names', () => {
  assert.equal(isInternal('$sys.log'), true);
  assert.equal(isInternal('$reply.1f9a2b3c'), false);
  assert.equal(isInternal('billing.sys'), false);
  assert.equal(isReply('$reply.1f9a2b3c'), true);
  assert.equal(isReply('$sys.log'), false);
});

test('validateName accepts derived contract names ending in a ClassName and rejects class-case domains', () => {
  for (const name of [
    'todos.CreateTodo',
    'billing.invoices.Issue',
    'billing.sim.RatesTicked',
    'todos.removed',
  ]) {
    assert.doesNotThrow(() => validateName(name), name);
  }

  for (const name of [
    'Todos.create',
    'todos.Create.todo',
    'CreateTodo',
    'todos.Create_Todo',
    '$todos.CreateTodo',
  ]) {
    assert.throws(() => validateName(name), MurmurError, name);
  }
});
