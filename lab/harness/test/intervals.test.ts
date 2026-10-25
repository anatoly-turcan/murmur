import assert from 'node:assert/strict'
import { test } from 'node:test'
import { concurrency, maxConcurrency, unionLength } from '../lib/intervals.ts'

test('overlapping intervals give concurrency above one', () => {
  const iv = [
    { start: 0, end: 10 },
    { start: 5, end: 15 },
    { start: 20, end: 30 },
  ]

  assert.equal(maxConcurrency(iv), 2)
  assert.equal(unionLength(iv), 25)
  assert.equal(concurrency(iv).mean, 30 / 25)
})

test('touching intervals do not overlap and zero-length ones count once', () => {
  assert.equal(maxConcurrency([{ start: 0, end: 5 }, { start: 5, end: 9 }]), 1)
  assert.equal(maxConcurrency([{ start: 0, end: 10 }, { start: 3, end: 3 }]), 2)
  assert.deepEqual(concurrency([]), { max: 0, mean: 0, busy_span_s: 0 })
})
