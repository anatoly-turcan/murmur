import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeJson } from '../lib/io.ts'
import type { RunMeta, SuiteTest } from '../lib/schema.ts'
import { collectRun, markdownRow } from '../collect.ts'
import { evaluateHypotheses, inputDrift, loadRuns, report } from '../tabulate.ts'
import { tempDir } from './helpers.ts'

const meta = (id: string, framework: 'murmur' | 'nestjs', model: 'opus' | 'sonnet', extra: Partial<RunMeta> = {}): RunMeta => ({
  schema: 1,
  id,
  phase: 'phase1',
  framework,
  model,
  n: Number(id.split('-')[2]),
  orchestrator_model: 'fable',
  implementer_model: model,
  reviewer_model: model,
  framework_ref: null,
  source_run: null,
  base_sha: null,
  inputs: {},
  timestamps: { created: '2026-11-01T00:00:00Z', kickoff: '2026-11-01T01:00:00Z', done: '2026-11-01T07:00:00Z', accepted: '2026-11-01T08:00:00Z' },
  shas: {},
  bounces: [],
  stop: null,
  meta: { db_engine: 'sqlite' },
  ...extra,
})

const tests = (trapPass: number): SuiteTest[] => [
  ...Array.from({ length: 4 }, (_, i) => ({
    name: `[A${i + 1}] t`,
    trapId: `A${i + 1}`,
    category: 'A',
    kind: 'trap' as const,
    status: (i < trapPass ? 'pass' : 'fail') as SuiteTest['status'],
  })),
  { name: '[SMOKE-1] s', category: 'smoke', kind: 'happy', status: 'pass' },
]

function writeRun(root: string, m: RunMeta, trapPass: number, tokens: number): string {
  const dir = join(root, 'phase1', m.id)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'run.json'), m)
  writeJson(join(dir, 'suite', 'results.json'), { complete: true, tests: tests(trapPass) })
  writeJson(join(dir, 'tokens.json'), { totals: { input: tokens, output: 10, cache_read: 0, cache_write: 0 }, agent_turns: 40 })
  writeJson(join(dir, 'bugs.json'), {
    tester_model: 'fable',
    bugs: [
      { id: 'b1', title: 'x', severity: 'major', confirmed: true, in_hidden_suite: false },
      { id: 'b2', title: 'y', severity: 'critical', confirmed: false, in_hidden_suite: false },
    ],
  })
  writeJson(join(dir, 'run-results.json'), collectRun(dir))

  return dir
}

test('collectRun merges every source and reports what is missing', () => {
  const root = tempDir('runs-')
  const dir = writeRun(root, meta('murmur-opus-1', 'murmur', 'opus'), 2, 1000)
  const r = collectRun(dir)

  assert.equal(r.suite?.weighted, (3 * 0.5 + 1) / 4)
  assert.equal(r.wall_clock_s, 6 * 3600)
  assert.equal(r.tokens?.total, 1010)
  assert.equal(r.bugs?.weighted, 3)
  assert.equal(r.status.accepted, true)
  assert.equal(r.db_engine, 'sqlite')
  assert.ok(r.missing.includes('perf.json'))
  assert.match(markdownRow(r), /^\| murmur-opus-1 \| yes \| 62\.5% \|/)
})

test('tabulate builds 2x2 tables and evaluates the hypotheses', () => {
  const root = tempDir('runs-')
  for (const n of [1, 2]) {
    writeRun(root, meta(`murmur-opus-${n}`, 'murmur', 'opus'), 4, 1000)
    writeRun(root, meta(`murmur-sonnet-${n}`, 'murmur', 'sonnet'), 4, 900)
    writeRun(root, meta(`nestjs-opus-${n}`, 'nestjs', 'opus'), 4, 1200)
    writeRun(root, meta(`nestjs-sonnet-${n}`, 'nestjs', 'sonnet'), 3, 1100)
  }
  const runs = loadRuns('phase1', root)
  assert.equal(runs.length, 8)
  const hypotheses = evaluateHypotheses('phase1', runs)
  assert.equal(hypotheses.length, 2)
  assert.match(hypotheses[0] ?? '', /H1 .*not supported/)
  assert.match(hypotheses[1] ?? '', /H2 .*: supported/)
  assert.deepEqual(inputDrift(runs), [])
  assert.deepEqual(inputDrift([{ ...runs[0], inputs: { spec_sha256: 'a' } }, { ...runs[1], inputs: { spec_sha256: 'b' } }] as typeof runs), ['Warning: spec_sha256 differs between runs.'])
  const text = report('phase1', runs)
  assert.match(text, /### Hidden suite, weighted score/)
  assert.match(text, /\| opus \| 100\.0% \(n=1\)|\| opus \| 1 \(1–1, n=2\)/)
})
