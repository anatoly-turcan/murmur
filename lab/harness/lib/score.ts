import { FAILED_OUTCOMES, PASSED_OUTCOMES, SUITE_TO_OUTCOME, TRAP_OUTCOMES, type SuiteTest, type TestKind, type TrapOutcome } from './schema.ts'
import { ratio } from './stats.ts'

export const KIND_WEIGHTS: Partial<Record<TestKind, number>> = { trap: 3, happy: 1, errors: 1 }

export interface Tally {
  total: number
  executed: number
  passed: number
  rate: number
}

export interface TrapScore {
  tests: number
  executed: number
  passed: number
  score: number | null
  verdict: 'pass' | 'fail' | 'skipped'
}

export interface SuiteScore {
  total: number
  executed: number
  passed: number
  skipped: number
  pass_rate: number
  weighted: number
  trap: { total: number; passed: number; rate: number }
  happy: Tally
  errors: Tally
  by_category: Record<string, Tally>
  by_trap: Record<string, TrapScore>
  trap_outcomes: Record<TrapOutcome | 'unclassified', number>
}

const executed = (t: SuiteTest) => t.status === 'pass' || t.status === 'fail'

function tally(tests: SuiteTest[]): Tally {
  const run = tests.filter(executed)
  const passed = run.filter((t) => t.status === 'pass').length

  return { total: tests.length, executed: run.length, passed, rate: ratio(passed, run.length) }
}

export function trapScores(tests: SuiteTest[]): Record<string, TrapScore> {
  const traps = tests.filter((t) => t.kind === 'trap' && t.trapId)
  const groups = Map.groupBy(traps, (t) => t.trapId as string)

  return Object.fromEntries(
    [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([id, group]) => {
      const t = tally(group)
      const verdict = t.executed === 0 ? 'skipped' : t.passed === t.executed ? 'pass' : 'fail'

      return [id, { tests: t.total, executed: t.executed, passed: t.passed, score: t.executed ? t.passed / t.executed : null, verdict }]
    }),
  )
}

export function kindRate(tests: SuiteTest[], kind: TestKind): number | null {
  if (kind === 'trap') {
    const scored = Object.values(trapScores(tests)).filter((t) => t.score !== null)

    return scored.length ? scored.reduce((sum, t) => sum + (t.score ?? 0), 0) / scored.length : null
  }
  const t = tally(tests.filter((x) => x.kind === kind))

  return t.executed ? t.rate : null
}

export function weightedScore(tests: SuiteTest[]): number {
  const parts = Object.entries(KIND_WEIGHTS).flatMap(([kind, weight]) => {
    const rate = kindRate(tests, kind as TestKind)

    return rate === null ? [] : [{ rate, weight: weight ?? 0 }]
  })

  return ratio(parts.reduce((s, p) => s + p.rate * p.weight, 0), parts.reduce((s, p) => s + p.weight, 0))
}

export function mergeTests(base: SuiteTest[], overrides: SuiteTest[] = []): SuiteTest[] {
  const byName = new Map(base.map((t) => [t.name, t]))
  for (const t of overrides) byName.set(t.name, t)

  return [...byName.values()]
}

const SEVERITY: readonly TrapOutcome[] = ['not_implemented', 'wrong', 'caught_by_own_tests', 'untested_but_works']

function fromSuite(failed: SuiteTest[]): TrapOutcome | 'unclassified' {
  const marks = new Set(failed.map((t) => (t.classification ? SUITE_TO_OUTCOME[t.classification] : undefined)))

  return SEVERITY.find((o) => marks.has(o)) ?? 'unclassified'
}

export function classifyTrap(id: string, trap: TrapScore, failed: SuiteTest[], given: TrapOutcome | undefined): TrapOutcome | 'unclassified' {
  if (given) {
    const allowed = trap.verdict === 'pass' ? PASSED_OUTCOMES : FAILED_OUTCOMES
    if (!allowed.includes(given)) throw new Error(`trap ${id} is ${trap.verdict} but classified "${given}"`)

    return given
  }

  return trap.verdict === 'fail' ? fromSuite(failed) : 'unclassified'
}

function trapOutcomes(tests: SuiteTest[], traps: Record<string, TrapScore>, given: Record<string, TrapOutcome>): SuiteScore['trap_outcomes'] {
  const counts = Object.fromEntries([...TRAP_OUTCOMES, 'unclassified'].map((k) => [k, 0])) as SuiteScore['trap_outcomes']
  for (const [id, trap] of Object.entries(traps)) {
    if (trap.verdict === 'skipped') continue
    const failed = tests.filter((t) => t.trapId === id && t.status === 'fail')
    counts[classifyTrap(id, trap, failed, given[id])] += 1
  }

  return counts
}

function byCategory(tests: SuiteTest[]): Record<string, Tally> {
  const groups = Map.groupBy(tests, (t) => t.category)

  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, tally(v)]))
}

export function scoreSuite(tests: SuiteTest[], given: Record<string, TrapOutcome> = {}): SuiteScore {
  const all = tally(tests)
  const traps = trapScores(tests)
  const scored = Object.values(traps).filter((t) => t.score !== null)

  return {
    total: all.total,
    executed: all.executed,
    passed: all.passed,
    skipped: all.total - all.executed,
    pass_rate: all.rate,
    weighted: weightedScore(tests),
    trap: { total: scored.length, passed: scored.filter((t) => t.verdict === 'pass').length, rate: kindRate(tests, 'trap') ?? 0 },
    happy: tally(tests.filter((t) => t.kind === 'happy')),
    errors: tally(tests.filter((t) => t.kind === 'errors')),
    by_category: byCategory(tests),
    by_trap: traps,
    trap_outcomes: trapOutcomes(tests, traps, given),
  }
}

export function isV1(t: SuiteTest): boolean {
  return (t.suite === undefined || t.suite === 'v1') && !/^CR/i.test(t.category)
}

export function regressions(before: SuiteTest[], after: SuiteTest[]): string[] {
  const passedBefore = new Set(before.filter((t) => isV1(t) && t.status === 'pass').map((t) => t.name))

  return after.filter((t) => isV1(t) && passedBefore.has(t.name) && t.status === 'fail').map((t) => t.name)
}
