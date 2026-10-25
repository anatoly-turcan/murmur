import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyTrap, mergeTests, regressions, scoreSuite, trapScores, weightedScore } from '../lib/score.ts'
import type { SuiteTest } from '../lib/schema.ts'

const trap = (name: string, trapId: string, status: SuiteTest['status'], extra: Partial<SuiteTest> = {}): SuiteTest => ({
  name: `[${trapId}] ${name}`,
  trapId,
  trapIds: [trapId],
  category: trapId[0] as string,
  kind: 'trap',
  status,
  ...extra,
})
const smoke = (n: number, status: SuiteTest['status']): SuiteTest => ({ name: `[SMOKE-${n}] s`, category: 'smoke', kind: 'happy', status })
const err = (n: number, status: SuiteTest['status']): SuiteTest => ({ name: `[ERR] e${n}`, category: 'errors', kind: 'errors', status })

test('traps weigh 3, smoke 1 and endpoint errors 1, independent of test counts', () => {
  assert.equal(weightedScore([trap('a', 'A1', 'pass'), smoke(1, 'fail')]), 0.75)
  assert.equal(weightedScore([trap('a', 'A1', 'pass'), trap('b', 'A1', 'fail'), smoke(1, 'pass')]), (1.5 + 1) / 4)
  const manyErrors = Array.from({ length: 400 }, (_, i) => err(i, 'pass'))
  assert.equal(weightedScore([trap('a', 'A1', 'fail'), smoke(1, 'fail'), ...manyErrors]), 1 / 5)
  assert.equal(weightedScore([trap('a', 'A1', 'pass'), trap('b', 'B1', 'fail'), smoke(1, 'pass'), err(1, 'pass')]), (3 * 0.5 + 1 + 1) / 5)
  assert.equal(weightedScore([]), 0)
})

test('skipped and todo tests leave the denominator', () => {
  assert.equal(weightedScore([trap('a', 'G1', 'skip'), smoke(1, 'pass'), err(1, 'todo')]), 1)
  assert.equal(trapScores([trap('a', 'G1', 'skip')]).G1?.verdict, 'skipped')
})

test('scoreSuite tallies traps, smoke, errors, categories and outcomes', () => {
  const tests = [
    trap('a', 'A1', 'pass'),
    trap('b', 'A2', 'fail', { classification: 'untested' }),
    trap('c', 'B1', 'fail', { classification: 'not_implemented' }),
    trap('d', 'B1', 'pass'),
    trap('e', 'G1', 'skip'),
    smoke(1, 'pass'),
    err(1, 'fail'),
  ]
  const s = scoreSuite(tests, { A1: 'covered' })

  assert.equal(s.total, 7)
  assert.equal(s.skipped, 1)
  assert.deepEqual(s.trap, { total: 3, passed: 1, rate: 1.5 / 3 })
  assert.equal(s.happy.rate, 1)
  assert.equal(s.errors.rate, 0)
  assert.deepEqual(s.by_category.B, { total: 2, executed: 2, passed: 1, rate: 0.5 })
  assert.equal(s.by_trap.B1?.verdict, 'fail')
  assert.equal(s.trap_outcomes.covered, 1)
  assert.equal(s.trap_outcomes.untested_but_works, 1)
  assert.equal(s.trap_outcomes.wrong, 0)
  assert.equal(s.trap_outcomes.not_implemented, 1)
  assert.equal(s.trap_outcomes.unclassified, 0)
})

test('the most severe per-test suite label decides a failed trap', () => {
  const s = scoreSuite([
    trap('a', 'A1', 'fail', { classification: 'untested' }),
    trap('b', 'A1', 'fail', { classification: 'wrong' }),
    trap('c', 'A2', 'fail', { classification: 'caught_by_own_tests' }),
  ])

  assert.equal(s.trap_outcomes.wrong, 1)
  assert.equal(s.trap_outcomes.caught_by_own_tests, 1)
  assert.equal(s.trap_outcomes.untested_but_works, 0)
})

test('an adjudicated outcome contradicting the verdict is rejected', () => {
  const pass = { tests: 1, executed: 1, passed: 1, score: 1, verdict: 'pass' as const }
  const fail = { tests: 1, executed: 1, passed: 0, score: 0, verdict: 'fail' as const }

  assert.throws(() => classifyTrap('A1', pass, [], 'wrong'), /classified "wrong"/)
  assert.throws(() => classifyTrap('A1', fail, [], 'covered'), /classified/)
  assert.equal(classifyTrap('A1', fail, [], 'untested_but_works'), 'untested_but_works')
  assert.equal(classifyTrap('A1', pass, [], 'untested_but_works'), 'untested_but_works')
  assert.equal(classifyTrap('A1', pass, [], undefined), 'unclassified')
})

test('adjudicated tests replace suite entries with the same name', () => {
  const merged = mergeTests([trap('x', 'L1', 'fail')], [trap('x', 'L1', 'pass'), trap('y', 'L2', 'pass')])

  assert.deepEqual(
    merged.map((x) => `${x.trapId}:${x.status}`),
    ['L1:pass', 'L2:pass'],
  )
})

test('regressions are v1 tests that passed before and fail after', () => {
  const before = [trap('a', 'A1', 'pass'), trap('b', 'A2', 'fail'), smoke(1, 'pass')]
  const after = [trap('a', 'A1', 'fail'), trap('b', 'A2', 'pass'), smoke(1, 'skip'), { ...smoke(2, 'fail'), category: 'CR1' }]

  assert.deepEqual(regressions(before, after), ['[A1] a'])
})
