import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMinor, meanHalfAwayFromZero, money, parseMinor } from '../src/money/money.ts';

test('parseMinor and formatMinor round-trip', () => {
  assert.equal(parseMinor('12.5', 2), 1250n);
  assert.equal(formatMinor(1250n, 2), '12.50');
  assert.equal(formatMinor(5n, 3), '0.005');
  assert.equal(formatMinor(-5n, 2), '-0.05');
  assert.equal(formatMinor(42n, 0), '42');
});

test('money serializes exact minor units beyond 2^53', () => {
  assert.deepEqual(money('USD', 900719925474099312n), {
    currency: 'USD',
    amount: '9007199254740993.12',
    amount_minor: '900719925474099312',
  });
});

test('mean rounds half away from zero', () => {
  assert.equal(meanHalfAwayFromZero(5n, 2n), 3n);
  assert.equal(meanHalfAwayFromZero(-5n, 2n), -3n);
  assert.equal(meanHalfAwayFromZero(4n, 3n), 1n);
  assert.equal(meanHalfAwayFromZero(0n, 0n), 0n);
});
