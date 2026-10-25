import { CHANGE_REQUESTS, type Phase } from './arms.ts'
import { TRAP_OUTCOMES } from './schema.ts'
import { TARGETS } from './perf.ts'
import type { RunResults } from '../collect.ts'

export interface Metric {
  key: string
  label: string
  better: 'higher' | 'lower' | 'none'
  get: (r: RunResults) => number | null | undefined
}

const m = (key: string, label: string, better: Metric['better'], get: Metric['get']): Metric => ({ key, label, better, get })

export function tokensPerCr(r: RunResults): number | null {
  const values = Object.values(r.crs ?? {}).map((c) => c.tokens_total)
  if (values.length === 0 || values.some((v) => v === null)) return null

  return (values as number[]).reduce((a, b) => a + b, 0) / values.length
}

function conflictsPerCrTotal(r: RunResults): number | null {
  const values = Object.values(r.crs ?? {}).map((c) => c.conflicted_merges)
  if (values.length === 0 || values.some((v) => v === null)) return r.git?.conflicted_merges ?? null

  return (values as number[]).reduce((a, b) => a + b, 0)
}

const QUALITY: Metric[] = [
  m('weighted', 'Hidden suite, weighted score W (trap 3, smoke 1, errors 1)', 'higher', (r) => r.suite?.weighted),
  m('pass_rate', 'Hidden suite, unweighted pass rate', 'higher', (r) => r.suite?.pass_rate),
  m('trap_rate', 'Trap score (mean per trap, partial credit)', 'higher', (r) => r.suite?.trap.rate),
  m('traps_fully_passed', 'Traps fully passed (count)', 'higher', (r) => r.suite?.trap.passed),
  m('happy_rate', 'Smoke (happy path) pass rate', 'higher', (r) => r.suite?.happy.rate),
  m('errors_rate', 'Endpoint error coverage pass rate', 'higher', (r) => r.suite?.errors.rate),
  m('skipped', 'Skipped hidden tests (count)', 'lower', (r) => r.suite?.skipped),
  ...TRAP_OUTCOMES.map((o) => m(`trap_${o}`, `Traps classified ${o} (count)`, 'none', (r) => r.suite?.trap_outcomes[o])),
  m('bugs_new', 'Adversarial tester: confirmed bugs not in hidden suite', 'lower', (r) => r.bugs?.confirmed_new),
  m('bugs_weighted', 'Adversarial tester: severity-weighted new bugs', 'lower', (r) => r.bugs?.weighted),
]

const EFFORT: Metric[] = [
  m('tokens_total', 'Tokens, total processed', 'lower', (r) => r.tokens?.total),
  m('tokens_fresh', 'Tokens, excluding cache reads', 'lower', (r) => r.tokens?.fresh),
  m('wall_h', 'Wall-clock hours', 'lower', (r) => (r.wall_clock_s === null ? null : r.wall_clock_s / 3600)),
  m('turns', 'Agent turns', 'lower', (r) => r.tokens?.agent_turns),
  m('bounces', 'Smoke bounce-backs', 'lower', (r) => r.status.bounces),
]

const PARALLEL: Metric[] = [
  m('par_max', 'Parallelism: max concurrent issue branches (fork-based)', 'higher', (r) => r.git?.parallel.upper.max),
  m('par_mean_upper', 'Parallelism: mean concurrency (fork-based)', 'higher', (r) => r.git?.parallel.upper.mean),
  m('par_mean_lower', 'Parallelism: mean concurrency (first-commit-based)', 'higher', (r) => r.git?.parallel.lower.mean),
  m('merges', 'Merged issue branches', 'none', (r) => r.git?.merges),
  m('conflicts', 'Merges with conflicts', 'lower', (r) => r.git?.conflicted_merges),
  m('conflict_lines', 'Conflict resolution lines (rework)', 'lower', (r) => r.git?.conflict_resolution_lines),
]

const PERF: Metric[] = [
  m('perf_met', 'Performance targets met (of 5)', 'higher', (r) => r.perf?.targets_met),
  ...TARGETS.flatMap((t) => [
    m(`p99_${t.key}`, `p99 ms, ${t.label} (target ${t.p99_ms})`, 'lower', (r) => r.perf?.p99_ms[t.key]),
    m(`rps_${t.key}`, `req/s achieved at the planned fixed rate, ${t.label}`, 'none', (r) => r.perf?.rps[t.key]),
  ]),
]

const CODE: Metric[] = [
  m('src_loc', 'Source LOC (no tests, deps, migrations)', 'none', (r) => r.code?.src_loc),
  m('deps_prod', 'Direct production dependencies', 'lower', (r) => r.code?.deps_prod),
  m('lock_packages', 'Locked packages (transitive)', 'lower', (r) => r.code?.lock_packages),
  m('test_cases', 'Own test cases', 'higher', (r) => r.code?.test_cases),
  m('cases_per_100', 'Own test cases per 100 source LOC', 'higher', (r) => r.code?.coverage_proxy.cases_per_100_src_loc),
  m('readability', 'Readability questionnaire, mean Likert (1–5)', 'higher', (r) => r.readability?.score),
  m('probe_minutes', 'Readability probes, total minutes', 'lower', (r) => r.readability?.probes_total_min),
]

const CHANGE: Metric[] = [
  m('tokens_per_cr', 'Tokens per change request (mean)', 'lower', tokensPerCr),
  m('conflicts_phase2', 'Merges with conflicts across CRs', 'lower', conflictsPerCrTotal),
  ...CHANGE_REQUESTS.flatMap((cr) => [
    m(`${cr}_weighted`, `${cr}: weighted score after delivery`, 'higher', (r) => r.crs?.[cr]?.suite?.weighted),
    m(`${cr}_tokens`, `${cr}: tokens`, 'lower', (r) => r.crs?.[cr]?.tokens_total),
    m(`${cr}_regressions`, `${cr}: v1 regressions`, 'lower', (r) => r.crs?.[cr]?.regressions?.length),
    m(`${cr}_wall_h`, `${cr}: wall-clock hours`, 'lower', (r) => {
      const s = r.crs?.[cr]?.wall_clock_s

      return s === null || s === undefined ? null : s / 3600
    }),
  ]),
]

export function categoryMetrics(runs: RunResults[]): Metric[] {
  const categories = [...new Set(runs.flatMap((r) => Object.keys(r.suite?.by_category ?? {})))].sort()

  return categories.map((c) => m(`cat_${c}`, `Category ${c} pass rate`, 'higher', (r) => r.suite?.by_category[c]?.rate))
}

export function metricsFor(phase: Phase, runs: RunResults[]): Metric[] {
  const shared = [...QUALITY, ...categoryMetrics(runs), ...EFFORT, ...PARALLEL, ...PERF, ...CODE]

  return phase === 'phase2' ? [...CHANGE, ...shared] : shared
}
