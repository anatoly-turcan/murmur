import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FRAMEWORKS, MODELS, PHASES, RUNS_ROOT, oneOf, type Framework, type Model, type Phase } from './lib/arms.ts'
import { optional, readFlags, runMain } from './lib/cli.ts'
import { readJsonIfExists } from './lib/io.ts'
import { metricsFor, tokensPerCr, type Metric } from './lib/metrics.ts'
import { formatNumber, formatSpread, spread, type Spread } from './lib/stats.ts'
import { markdownTable } from './lib/table.ts'
import { ROW_HEADERS, markdownRow, type RunResults } from './collect.ts'

const USAGE = 'node tabulate.ts --phase phase1|phase2 [--runs-root <dir>] [--json]'
const PARITY_MARGIN = 0.05
const TOKEN_ADVANTAGE = 0.85

type Cell = { framework: Framework; model: Model | 'all' }

export function loadRuns(phase: Phase, runsRoot = RUNS_ROOT): RunResults[] {
  const dir = join(runsRoot, phase)
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  return names
    .map((n) => readJsonIfExists<RunResults>(join(dir, n, 'run-results.json')))
    .filter((r) => r !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id))
}

function select(runs: RunResults[], cell: Cell): RunResults[] {
  return runs.filter((r) => r.framework === cell.framework && (cell.model === 'all' || r.model === cell.model))
}

export function cellSpread(runs: RunResults[], cell: Cell, get: Metric['get']): Spread | undefined {
  const values = select(runs, cell)
    .map(get)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

  return spread(values)
}

function delta(a: Spread | undefined, b: Spread | undefined): string {
  if (!a || !b) return '—'
  const d = a.mean - b.mean

  return `${d > 0 ? '+' : ''}${formatNumber(d)}`
}

export function metricTable(runs: RunResults[], metric: Metric): string {
  const rows = [...MODELS, 'all' as const].map((model) => {
    const [mur, nest] = FRAMEWORKS.map((framework) => cellSpread(runs, { framework, model }, metric.get))

    return [model, formatSpread(mur), formatSpread(nest), delta(mur, nest)]
  })
  const better = metric.better === 'none' ? '' : ` (${metric.better} is better)`

  return `### ${metric.label}${better}\n\n${markdownTable(['implementer', 'murmur', 'nestjs', 'Δ murmur − nestjs'], rows)}`
}

function mean(runs: RunResults[], cell: Cell, get: Metric['get']): number | undefined {
  return cellSpread(runs, cell, get)?.mean
}

function enough(runs: RunResults[], cells: Cell[]): boolean {
  return cells.every((c) => select(runs, c).length >= 2)
}

const ALL_CELLS: Cell[] = FRAMEWORKS.flatMap((framework) => MODELS.map((model) => ({ framework, model })))

export function evaluateHypotheses(phase: Phase, runs: RunResults[]): string[] {
  const weighted = (r: RunResults) => r.suite?.weighted
  const trap = (r: RunResults) => r.suite?.trap.rate
  const verdict = (ok: boolean | undefined) => (ok === undefined ? 'insufficient data' : ok ? 'supported' : 'not supported')
  const out: string[] = []
  if (!enough(runs, ALL_CELLS)) out.push('Warning: at least one arm has fewer than 2 runs; verdicts are provisional.')
  if (phase === 'phase1') {
    const gaps = [...MODELS, 'all' as const].map((model) => {
      const a = mean(runs, { framework: 'murmur', model }, weighted)
      const b = mean(runs, { framework: 'nestjs', model }, weighted)

      return a === undefined || b === undefined ? undefined : Math.abs(a - b)
    })
    const h1 = gaps.some((g) => g === undefined) ? undefined : gaps.every((g) => (g as number) <= PARITY_MARGIN)
    out.push(`H1 parity (|Δ weighted| ≤ ${PARITY_MARGIN} per model and pooled): ${verdict(h1)} — gaps ${gaps.map((g) => (g === undefined ? '—' : g.toFixed(3))).join(' / ')} (opus / sonnet / all)`)
  }
  const ms = (get: Metric['get']) => mean(runs, { framework: 'murmur', model: 'sonnet' }, get)
  const no = (get: Metric['get']) => mean(runs, { framework: 'nestjs', model: 'opus' }, get)
  const pairs = [ms(weighted), no(weighted), ms(trap), no(trap)]
  const h2 = pairs.some((v) => v === undefined) ? undefined : (pairs[0] as number) >= (pairs[1] as number) && (pairs[2] as number) >= (pairs[3] as number)
  out.push(`H2 murmur+sonnet ≥ nestjs+opus on weighted score and trap rate: ${verdict(h2)}`)
  if (phase === 'phase2') {
    const conflicts = (r: RunResults) => r.git?.conflicted_merges
    const checks = MODELS.map((model) => {
      const tm = mean(runs, { framework: 'murmur', model }, tokensPerCr)
      const tn = mean(runs, { framework: 'nestjs', model }, tokensPerCr)
      const cm = mean(runs, { framework: 'murmur', model }, conflicts)
      const cn = mean(runs, { framework: 'nestjs', model }, conflicts)
      const wm = mean(runs, { framework: 'murmur', model }, weighted)
      const wn = mean(runs, { framework: 'nestjs', model }, weighted)
      if ([tm, tn, cm, cn, wm, wn].some((v) => v === undefined)) return undefined

      return (tm as number) <= TOKEN_ADVANTAGE * (tn as number) && (cm as number) <= (cn as number) && (wm as number) >= (wn as number) - PARITY_MARGIN
    })
    const h3 = checks.some((c) => c === undefined) ? undefined : checks.every(Boolean)
    out.push(`H3 murmur ≤ ${TOKEN_ADVANTAGE}× nestjs tokens per CR, ≤ conflicts, weighted within ${PARITY_MARGIN}, for both models: ${verdict(h3)}`)
  }

  return out
}

export function inputDrift(runs: RunResults[]): string[] {
  const keys = [...new Set(runs.flatMap((r) => Object.keys(r.inputs ?? {})))].filter((k) => !k.startsWith('kickoff'))
  const drift = keys.filter((k) => new Set(runs.map((r) => r.inputs?.[k])).size > 1)
  const refs = new Set(runs.filter((r) => r.framework === 'murmur').map((r) => r.framework_ref))

  return [...drift.map((k) => `Warning: ${k} differs between runs.`), ...(refs.size > 1 ? ['Warning: murmur runs used different framework refs.'] : [])]
}

export function report(phase: Phase, runs: RunResults[]): string {
  const rows = markdownTable(ROW_HEADERS, []).split('\n').concat(runs.map(markdownRow)).join('\n')
  const tables = metricsFor(phase, runs).map((metric) => metricTable(runs, metric))

  return [`# Results — ${phase} (${runs.length} runs)`, '## Hypotheses', [...inputDrift(runs), ...evaluateHypotheses(phase, runs)].map((l) => `- ${l}`).join('\n'), '## Runs', rows, '## Metrics', ...tables].join('\n\n')
}

if (import.meta.main) {
  await runMain(USAGE, () => {
    const f = readFlags(process.argv.slice(2), { phase: 'string', 'runs-root': 'string', json: 'boolean' })
    const phase = oneOf(PHASES, optional(f, 'phase') ?? 'phase1', 'phase')
    const runs = loadRuns(phase, optional(f, 'runs-root'))
    if (f.json) {
      const table = Object.fromEntries(
        metricsFor(phase, runs).map((metric) => [metric.key, Object.fromEntries([...ALL_CELLS, { framework: 'murmur', model: 'all' }, { framework: 'nestjs', model: 'all' }].map((c) => [`${c.framework}-${c.model}`, cellSpread(runs, c as Cell, metric.get) ?? null]))]),
      )
      console.log(JSON.stringify({ phase, runs: runs.length, hypotheses: evaluateHypotheses(phase, runs), metrics: table }, null, 2))

      return
    }
    console.log(report(phase, runs))
  })
}
