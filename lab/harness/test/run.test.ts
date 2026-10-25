import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { LAB_ROOT } from '../lib/arms.ts'
import { git } from '../lib/git.ts'
import { readJson, writeJson } from '../lib/io.ts'
import type { RunMeta } from '../lib/schema.ts'
import { createRun } from '../new-run.ts'
import { stamp } from '../stamp.ts'
import { tempDir } from './helpers.ts'

const AT = '2026-11-02T09:00:00.000Z'

const roots = new Map<string, string>()

function runsOutside(lab: string): string {
  if (!roots.has(lab)) roots.set(lab, tempDir('runs-'))

  return roots.get(lab) as string
}

function fakeLab(): string {
  const lab = tempDir('lab-')
  writeFileSync(join(lab, 'SPEC.md'), '# spec\n')
  writeFileSync(join(lab, 'SMOKE.md'), '# smoke\n')
  mkdirSync(join(lab, 'experiment'))
  writeFileSync(join(lab, 'experiment', 'PHASE2.md'), readFileSync(join(LAB_ROOT, 'experiment', 'PHASE2.md'), 'utf8'))

  return lab
}

test('phase1 run: fresh repo with only spec, smoke and framework pointer; metadata outside the repo', () => {
  const lab = fakeLab()
  const dir = createRun({ phase: 'phase1', framework: 'murmur', model: 'sonnet', n: 1, createdAt: AT, frameworkRef: '/opt/fw/murmur', labRoot: lab, runsRoot: runsOutside(lab) })

  assert.equal(dir, join(runsOutside(lab), 'phase1', 'murmur-sonnet-1'))
  assert.deepEqual(git(join(dir, 'repo'), ['ls-files']).trim().split('\n').sort(), ['.npmrc', 'FRAMEWORK.md', 'SMOKE.md', 'SPEC.md'])
  assert.match(readFileSync(join(dir, 'repo', '.npmrc'), 'utf8'), /^registry=http:\/\/.+\/\n$/)
  assert.match(readFileSync(join(dir, 'launch.sh'), 'utf8'), /--settings \.\.\/session-settings\.json --plugin-dir "\/opt\/fw\/murmur\/plugins\/murmur"/)
  assert.match(readFileSync(join(dir, 'repo', 'FRAMEWORK.md'), 'utf8'), /\/opt\/fw\/murmur/)
  assert.match(readFileSync(join(dir, 'kickoff.md'), 'utf8'), /\/opt\/fw\/murmur/)
  const meta = readJson<RunMeta>(join(dir, 'run.json'))
  assert.equal(meta.orchestrator_model, 'fable')
  assert.equal(meta.implementer_model, 'sonnet')
  assert.equal(meta.timestamps.created, AT)
  assert.equal(git(join(dir, 'repo'), ['log', '-1', '--format=%cI']).trim(), '2026-11-02T09:00:00+00:00')
  const settings = readJson<{ env: Record<string, string>; permissions: { deny: string[] } }>(join(dir, 'session-settings.json'))
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, 'sonnet')
  assert.equal(settings.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0')
  assert.ok(settings.permissions.deny.includes(`Read(/${lab}/**)`))
  assert.throws(() => createRun({ phase: 'phase1', framework: 'murmur', model: 'sonnet', n: 1, createdAt: AT, frameworkRef: '/opt/fw/murmur', labRoot: lab, runsRoot: runsOutside(lab) }), /already exists/)
})

test('the runs root must live outside the lab repo', () => {
  const lab = fakeLab()

  assert.throws(() => createRun({ phase: 'phase1', framework: 'nestjs', model: 'opus', n: 1, createdAt: AT, labRoot: lab, runsRoot: join(lab, 'runs') }), /must be outside the lab repo/)
})

test('nestjs runs get no registry file and no plugin flag', () => {
  const lab = fakeLab()
  const dir = createRun({ phase: 'phase1', framework: 'nestjs', model: 'opus', n: 3, createdAt: AT, labRoot: lab, runsRoot: runsOutside(lab) })

  assert.deepEqual(git(join(dir, 'repo'), ['ls-files']).trim().split('\n').sort(), ['FRAMEWORK.md', 'SMOKE.md', 'SPEC.md'])
  const launch = readFileSync(join(dir, 'launch.sh'), 'utf8')
  assert.doesNotMatch(launch, /plugin-dir/)
  assert.match(launch, /--settings \.\.\/session-settings\.json/)
})

test('murmur runs require an absolute framework ref', () => {
  const lab = fakeLab()

  assert.throws(() => createRun({ phase: 'phase1', framework: 'murmur', model: 'opus', n: 1, createdAt: AT, labRoot: lab, runsRoot: runsOutside(lab) }), /framework-ref/)
})

test('phase2 run clones the accepted phase1 repo and writes three CR kickoffs', () => {
  const lab = fakeLab()
  const runs = runsOutside(lab)
  const p1 = createRun({ phase: 'phase1', framework: 'nestjs', model: 'opus', n: 2, createdAt: AT, labRoot: lab, runsRoot: runs })
  assert.throws(() => createRun({ phase: 'phase2', framework: 'nestjs', model: 'opus', n: 2, createdAt: AT, from: p1, labRoot: lab, runsRoot: runs }), /never accepted/)
  const meta = readJson<RunMeta>(join(p1, 'run.json'))
  writeJson(join(p1, 'run.json'), stamp(meta, { event: 'accepted', at: AT }))
  const p2 = createRun({ phase: 'phase2', framework: 'nestjs', model: 'opus', n: 2, createdAt: AT, from: p1, labRoot: lab, runsRoot: runs })

  for (const k of ['cr1', 'cr2', 'cr3']) assert.ok(existsSync(join(p2, `kickoff-${k}.md`)))
  assert.equal(git(join(p2, 'repo'), ['remote']).trim(), '')
  const m2 = readJson<RunMeta>(join(p2, 'run.json'))
  assert.equal(m2.source_run, '../../phase1/nestjs-opus-2')
  assert.equal(m2.base_sha, meta.base_sha)
  assert.throws(() => createRun({ phase: 'phase2', framework: 'nestjs', model: 'sonnet', n: 2, createdAt: AT, from: p1, labRoot: lab, runsRoot: runs }), /expected phase1/)
})

test('stamp records events, bounces, stops and meta', () => {
  const base = { timestamps: { created: AT }, bounces: [], shas: {}, stop: null, meta: {} } as unknown as RunMeta
  const done = stamp(base, { event: 'done', at: AT, sha: 'abc' })
  const bounced = stamp(done, { event: 'bounce', at: AT })
  const stopped = stamp(bounced, { event: 'stopped', at: AT, reason: 'token_cap' })
  const tagged = stamp(stopped, { set: 'db_engine=sqlite' })

  assert.equal(tagged.timestamps.done, AT)
  assert.equal(tagged.shas.done, 'abc')
  assert.equal(tagged.bounces.length, 1)
  assert.deepEqual(tagged.stop, { reason: 'token_cap', at: AT })
  assert.equal(tagged.meta.db_engine, 'sqlite')
  assert.throws(() => stamp(base, { event: 'lunch', at: AT }), /--event must be one of/)
})
