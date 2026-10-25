import { join, resolve } from 'node:path'
import { CHANGE_REQUESTS, crKey, type Framework, type Model, type Phase } from './lib/arms.ts'
import { readFlags, required, runMain } from './lib/cli.ts'
import { readJsonIfExists, writeJson, writeText } from './lib/io.ts'
import { mergeTests, regressions, scoreSuite, type SuiteScore } from './lib/score.ts'
import { existsSync } from 'node:fs'
import type { Adjudication, BugsFile, ReadabilityFile, RunMeta, SuiteResults, SuiteTest, TokenCounts, TokensFile } from './lib/schema.ts'
import { formatNumber } from './lib/stats.ts'
import type { CodeMetrics } from './measure-code.ts'
import type { GitMetrics } from './measure-git.ts'
import type { TargetResult } from './lib/perf.ts'

const USAGE = 'node collect.ts --run <run dir>'
const SEVERITY_WEIGHT = { critical: 5, major: 3, minor: 1 }

export interface CrResult {
  suite: SuiteScore | null
  regressions: string[] | null
  tokens_total: number | null
  wall_clock_s: number | null
  conflicted_merges: number | null
}

export interface RunResults {
  schema: 1
  id: string
  phase: Phase
  framework: Framework
  model: Model
  n: number
  db_engine: string | null
  inputs: Record<string, string>
  framework_ref: string | null
  status: { accepted: boolean; done_reported: boolean; bounces: number; stop_reason: string | null }
  suite: SuiteScore | null
  crs: Record<string, CrResult> | null
  bugs: { reported: number; confirmed: number; confirmed_new: number; weighted: number } | null
  tokens: (TokenCounts & { total: number; fresh: number; agent_turns: number | null; agents_spawned: number | null; usd: number | null }) | null
  wall_clock_s: number | null
  git: Omit<GitMetrics, 'merges_detail'> | null
  perf: { targets_met: number; valid: boolean; p99_ms: Record<string, number>; rps: Record<string, number>; rss_max_mib: Record<string, number> | null } | null
  code: {
    src_loc: number
    test_loc: number
    migration_loc: number
    test_files: number
    test_cases: number
    deps_prod: number
    deps_dev: number
    lock_packages: number
    units: CodeMetrics['units']
    coverage_proxy: CodeMetrics['coverage_proxy']
  } | null
  readability: { score: number; probes_total_min: number; likert: Record<string, number> } | null
  missing: string[]
}

interface Inputs {
  meta: RunMeta
  adjudication: Adjudication | undefined
  code: CodeMetrics | undefined
  git: GitMetrics | undefined
  perf: { targets_met: number; valid: boolean; targets: Record<string, TargetResult>; rss_max_mib: Record<string, number> | null } | undefined
  tokens: TokensFile | undefined
  bugs: BugsFile | undefined
  readability: ReadabilityFile | undefined
}

function seconds(from: string | undefined, to: string | undefined): number | null {
  if (!from || !to) return null

  return (Date.parse(to) - Date.parse(from)) / 1000
}

export function tokenTotal(t: TokenCounts): number {
  return t.input + t.output + t.cache_read + t.cache_write
}

export function suiteFile(dir: string, key?: string): string {
  const flat = join(dir, key ? `results-${key}.json` : 'results.json')

  return existsSync(flat) ? flat : join(dir, key ? `suite-${key}` : 'suite', 'results.json')
}

function suiteTests(dir: string, key: string | undefined, adjudication: Adjudication | undefined): SuiteTest[] | undefined {
  const results = readJsonIfExists<SuiteResults>(suiteFile(dir, key))

  return results ? mergeTests(results.tests, adjudication?.tests) : undefined
}

function tokensSummary(t: TokensFile | undefined): RunResults['tokens'] {
  if (!t) return null

  return {
    ...t.totals,
    total: tokenTotal(t.totals),
    fresh: t.totals.input + t.totals.output + t.totals.cache_write,
    agent_turns: t.agent_turns ?? null,
    agents_spawned: t.agents_spawned ?? null,
    usd: t.usd ?? null,
  }
}

function bugsSummary(b: BugsFile | undefined): RunResults['bugs'] {
  if (!b) return null
  const confirmed = b.bugs.filter((x) => x.confirmed)
  const fresh = confirmed.filter((x) => !x.in_hidden_suite)

  return {
    reported: b.bugs.length,
    confirmed: confirmed.length,
    confirmed_new: fresh.length,
    weighted: fresh.reduce((sum, x) => sum + SEVERITY_WEIGHT[x.severity], 0),
  }
}

function perfSummary(p: Inputs['perf']): RunResults['perf'] {
  if (!p) return null
  const entries = Object.entries(p.targets)

  return {
    targets_met: p.targets_met,
    valid: p.valid,
    p99_ms: Object.fromEntries(entries.map(([k, v]) => [k, v.p99_ms])),
    rps: Object.fromEntries(entries.map(([k, v]) => [k, v.rps])),
    rss_max_mib: p.rss_max_mib,
  }
}

function codeSummary(c: CodeMetrics | undefined): RunResults['code'] {
  if (!c) return null

  return {
    src_loc: c.src.loc,
    test_loc: c.test.loc,
    migration_loc: c.migration.loc,
    test_files: c.test.files,
    test_cases: c.test.cases,
    deps_prod: c.deps.direct_prod,
    deps_dev: c.deps.direct_dev,
    lock_packages: c.deps.lock_packages,
    units: c.units,
    coverage_proxy: c.coverage_proxy,
  }
}

function readabilitySummary(r: ReadabilityFile | undefined): RunResults['readability'] {
  if (!r) return null
  const values = Object.values(r.likert)

  return {
    score: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    probes_total_min: Object.values(r.probes_minutes).reduce((a, b) => a + b, 0),
    likert: r.likert,
  }
}

function gitSummary(g: GitMetrics | undefined): RunResults['git'] {
  if (!g) return null
  const { merges_detail: _detail, ...rest } = g

  return rest
}

function phase1Parts(dir: string, inputs: Inputs) {
  const tests = suiteTests(dir, undefined, inputs.adjudication)
  const t = inputs.meta.timestamps
  const end = t.done ?? inputs.meta.stop?.at

  return { suite: tests ? scoreSuite(tests, inputs.adjudication?.trap_outcomes) : null, crs: null, wall: seconds(t.kickoff, end), missing: tests ? [] : ['results.json (or suite/results.json)'] }
}

function phase2Parts(dir: string, inputs: Inputs) {
  const { meta, adjudication, tokens } = inputs
  const sourceDir = meta.source_run ? resolve(dir, meta.source_run) : undefined
  let previous = sourceDir ? suiteTests(sourceDir, undefined, undefined) : undefined
  const crs: Record<string, CrResult> = {}
  const missing: string[] = []
  let last: SuiteTest[] | undefined
  for (const cr of CHANGE_REQUESTS) {
    const key = crKey(cr)
    const tests = suiteTests(dir, key, adjudication)
    if (!tests) missing.push(`results-${key}.json (or suite-${key}/results.json)`)
    const crTokens = tokens?.by_cr?.[cr]
    const crGit = readJsonIfExists<GitMetrics>(join(dir, `git-${key}.json`))
    crs[cr] = {
      suite: tests ? scoreSuite(tests, adjudication?.trap_outcomes) : null,
      regressions: tests && previous ? regressions(previous, tests) : null,
      tokens_total: crTokens ? tokenTotal(crTokens) : null,
      wall_clock_s: seconds(meta.timestamps[`${key}_start`], meta.timestamps[`${key}_done`]),
      conflicted_merges: crGit?.conflicted_merges ?? null,
    }
    previous = tests ?? previous
    last = tests ?? last
  }
  const walls = Object.values(crs).map((c) => c.wall_clock_s)
  const wall = walls.every((w) => w !== null) ? walls.reduce<number>((a, b) => a + (b ?? 0), 0) : null

  return { suite: last ? scoreSuite(last, adjudication?.trap_outcomes) : null, crs, wall, missing }
}

function readInputs(dir: string): Inputs {
  const meta = readJsonIfExists<RunMeta>(join(dir, 'run.json'))
  if (!meta) throw new Error(`${dir}/run.json not found`)

  return {
    meta,
    adjudication: readJsonIfExists(join(dir, 'adjudication.json')),
    code: readJsonIfExists(join(dir, 'code.json')),
    git: readJsonIfExists(join(dir, 'git.json')),
    perf: readJsonIfExists(join(dir, 'perf.json')),
    tokens: readJsonIfExists(join(dir, 'tokens.json')),
    bugs: readJsonIfExists(join(dir, 'bugs.json')),
    readability: readJsonIfExists(join(dir, 'readability.json')),
  }
}

function missingOptional(inputs: Inputs): string[] {
  const files: Array<[keyof Inputs, string]> = [
    ['adjudication', 'adjudication.json'],
    ['code', 'code.json'],
    ['git', 'git.json'],
    ['perf', 'perf.json'],
    ['tokens', 'tokens.json'],
    ['bugs', 'bugs.json'],
    ['readability', 'readability.json'],
  ]

  return files.filter(([k]) => inputs[k] === undefined).map(([, f]) => f)
}

export function collectRun(dir: string): RunResults {
  const inputs = readInputs(dir)
  const { meta } = inputs
  const parts = meta.phase === 'phase1' ? phase1Parts(dir, inputs) : phase2Parts(dir, inputs)
  const accepted = meta.phase === 'phase1' ? Boolean(meta.timestamps.accepted) : Boolean(meta.timestamps.cr3_accepted)

  return {
    schema: 1,
    id: meta.id,
    phase: meta.phase,
    framework: meta.framework,
    model: meta.model,
    n: meta.n,
    db_engine: meta.meta.db_engine ?? (inputs.code?.deps.db_hints.join('+') || null),
    inputs: meta.inputs,
    framework_ref: meta.framework_ref,
    status: { accepted, done_reported: Boolean(meta.timestamps.done ?? meta.timestamps.cr3_done), bounces: meta.bounces.length, stop_reason: meta.stop?.reason ?? null },
    suite: parts.suite,
    crs: parts.crs,
    bugs: bugsSummary(inputs.bugs),
    tokens: tokensSummary(inputs.tokens),
    wall_clock_s: parts.wall,
    git: gitSummary(inputs.git),
    perf: perfSummary(inputs.perf),
    code: codeSummary(inputs.code),
    readability: readabilitySummary(inputs.readability),
    missing: [...parts.missing, ...missingOptional(inputs)],
  }
}

const cell = (v: number | null | undefined, pct = false) =>
  v === null || v === undefined ? '—' : pct ? `${(v * 100).toFixed(1)}%` : formatNumber(v)

export const ROW_HEADERS = ['run', 'accepted', 'weighted', 'trap', 'smoke', 'bugs (new, wtd)', 'tokens', 'wall h', 'conflicts', 'max par.', 'perf met', 'src LOC', 'tests']

export function markdownRow(r: RunResults): string {
  const cells = [
    r.id,
    r.status.accepted ? 'yes' : `no${r.status.stop_reason ? ` (${r.status.stop_reason})` : ''}`,
    cell(r.suite?.weighted, true),
    cell(r.suite?.trap.rate, true),
    cell(r.suite?.happy.rate, true),
    cell(r.bugs?.weighted),
    cell(r.tokens?.total),
    cell(r.wall_clock_s === null ? null : r.wall_clock_s / 3600),
    cell(r.git?.conflicted_merges),
    cell(r.git?.parallel.upper.max),
    r.perf ? `${r.perf.targets_met}/5${r.perf.valid ? '' : ' (invalid)'}` : '—',
    cell(r.code?.src_loc),
    cell(r.code?.test_cases),
  ]

  return `| ${cells.join(' | ')} |`
}

if (import.meta.main) {
  await runMain(USAGE, () => {
    const dir = resolve(required(readFlags(process.argv.slice(2), { run: 'string' }), 'run'))
    const results = collectRun(dir)
    writeJson(join(dir, 'run-results.json'), results)
    writeText(join(dir, 'row.md'), `${markdownRow(results)}\n`)
    console.log(markdownRow(results))
    if (results.missing.length) console.error(`missing: ${results.missing.join(', ')}`)
  })
}
