import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  CANDIDATE_PORT,
  NPM_REGISTRY,
  CHANGE_REQUESTS,
  FRAMEWORKS,
  LAB_ROOT,
  MODELS,
  ORCHESTRATOR_MODEL,
  PHASES,
  RUNS_ROOT,
  crKey,
  oneOf,
  runDir,
  runId,
  type Framework,
  type Model,
  type Phase,
} from './lib/arms.ts'
import { isoTimestamp, optional, positiveInt, readFlags, required, runMain } from './lib/cli.ts'
import { assertHostFree } from './lib/guard.ts'
import { git } from './lib/git.ts'
import { readJson, sha256, writeJson, writeText } from './lib/io.ts'
import { extractChangeRequests, frameworkParagraph, renderCrKickoff, renderKickoff } from './lib/kickoff.ts'
import type { RunMeta } from './lib/schema.ts'

const USAGE =
  'node new-run.ts --phase phase1|phase2 --framework murmur|nestjs --model opus|sonnet --n <int> --created-at <iso> [--framework-ref <abs path>] [--from <phase1 run dir>] [--runs-root <dir>, default $LAB_RUNS_ROOT or <lab>/../../murmur-runs] [--port 8085, default $LAB_CANDIDATE_PORT]'

export interface NewRunOptions {
  phase: Phase
  framework: Framework
  model: Model
  n: number
  createdAt: string
  frameworkRef?: string
  from?: string
  runsRoot?: string
  labRoot?: string
}

const OWNER_ENV = (at: string) => ({
  GIT_AUTHOR_NAME: 'Product Owner',
  GIT_AUTHOR_EMAIL: 'owner@example.invalid',
  GIT_COMMITTER_NAME: 'Product Owner',
  GIT_COMMITTER_EMAIL: 'owner@example.invalid',
  GIT_AUTHOR_DATE: at,
  GIT_COMMITTER_DATE: at,
})

function templateVars(o: NewRunOptions): Record<string, string> {
  if (o.framework !== 'murmur') return {}
  if (!o.frameworkRef || !isAbsolute(o.frameworkRef)) throw new Error('--framework-ref <absolute path> is required for murmur')

  return { FRAMEWORK_REF: o.frameworkRef }
}

export function sessionSettings(o: NewRunOptions, labRoot: string, runsRoot: string): object {
  const denied = [`/${labRoot}/**`, `/${runsRoot}/*/*/*.json`, `/${runsRoot}/*/*/*.md`]
  const webDeny = o.framework === 'murmur' ? ['WebSearch', 'WebFetch'] : ['WebSearch']

  return {
    env: { CLAUDE_CODE_SUBAGENT_MODEL: o.model, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' },
    permissions: {
      deny: [...denied.flatMap((p) => [`Read(${p})`, `Edit(${p})`]), ...webDeny],
      ...(o.framework === 'nestjs' ? { allow: ['WebFetch(domain:docs.nestjs.com)'] } : {}),
    },
  }
}

function baseMeta(o: NewRunOptions, id: string, inputs: Record<string, string>): RunMeta {
  return {
    schema: 1,
    id,
    phase: o.phase,
    framework: o.framework,
    model: o.model,
    n: o.n,
    orchestrator_model: ORCHESTRATOR_MODEL,
    implementer_model: o.model,
    reviewer_model: o.model,
    framework_ref: o.frameworkRef ?? null,
    source_run: null,
    base_sha: null,
    inputs,
    timestamps: { created: o.createdAt },
    shas: {},
    bounces: [],
    stop: null,
    meta: {},
  }
}

function initRepo(repo: string, files: Record<string, string>, at: string): string {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '--quiet', '--initial-branch=main'])
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content)
  git(repo, ['add', '--all'])
  git(repo, ['commit', '--quiet', '-m', 'Initial specification'], OWNER_ENV(at))

  return git(repo, ['rev-parse', 'HEAD']).trim()
}

function registryFiles(o: NewRunOptions): Record<string, string> {
  return o.framework === 'murmur' ? { '.npmrc': `registry=${NPM_REGISTRY}/\n` } : {}
}

export function launchScript(o: NewRunOptions): string {
  const plugin = o.framework === 'murmur' ? ` --plugin-dir "${o.frameworkRef}/plugins/murmur"` : ''

  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'cd "$(dirname "$0")/repo"',
    `exec claude --model "\${LAB_ORCHESTRATOR_MODEL:-${ORCHESTRATOR_MODEL}}" --settings ../session-settings.json${plugin} "$@"`,
    '',
  ].join('\n')
}

export const TEAM_USER = process.env.LAB_TEAM_USER || 'labteam'

function grantTeamUser(dir: string): void {
  const exists = spawnSync('id', ['-u', TEAM_USER], { encoding: 'utf8' }).status === 0
  if (!exists) {
    return
  }

  chmodSync(dir, 0o711)

  for (const name of readdirSync(dir)) {
    if (name.endsWith('.json') || name.endsWith('.md')) {
      chmodSync(join(dir, name), 0o600)
    }
  }

  const repo = join(dir, 'repo')
  const acl = spawnSync('setfacl', ['-R', '-m', `u:${TEAM_USER}:rwX,d:u:${TEAM_USER}:rwX`, repo], { encoding: 'utf8' })
  if (acl.status !== 0) {
    throw new Error(`setfacl on ${repo} failed: ${acl.stderr}`)
  }
}

function createPhase1(o: NewRunOptions, dir: string, labRoot: string): RunMeta {
  const vars = templateVars(o)
  const spec = readFileSync(join(labRoot, 'SPEC.md'), 'utf8')
  const smoke = readFileSync(join(labRoot, 'SMOKE.md'), 'utf8')
  const pointer = `${frameworkParagraph(o.framework, vars)}\n`
  const kickoff = renderKickoff(o.framework, vars)
  const files = { 'SPEC.md': spec, 'SMOKE.md': smoke, 'FRAMEWORK.md': pointer, ...registryFiles(o) }
  const baseSha = initRepo(join(dir, 'repo'), files, o.createdAt)
  writeText(join(dir, 'kickoff.md'), kickoff)
  const meta = baseMeta(o, runId(o.framework, o.model, o.n), {
    spec_sha256: sha256(spec),
    smoke_sha256: sha256(smoke),
    kickoff_sha256: sha256(kickoff),
  })

  return { ...meta, base_sha: baseSha, shas: { base: baseSha } }
}

function createPhase2(o: NewRunOptions, dir: string, labRoot: string): RunMeta {
  if (!o.from) throw new Error('--from <phase1 run dir> is required for phase2')
  const source = readJson<RunMeta>(join(o.from, 'run.json'))
  if (source.phase !== 'phase1' || source.framework !== o.framework || source.model !== o.model || source.n !== o.n) {
    throw new Error(`--from ${o.from} is ${source.id} (${source.phase}); expected phase1 ${runId(o.framework, o.model, o.n)}`)
  }
  if (!source.timestamps.accepted) throw new Error(`${source.id} was never accepted (stamp it with --event accepted first)`)
  const repo = join(dir, 'repo')
  git(dir, ['clone', '--quiet', '--no-local', '--branch', 'main', join(o.from, 'repo'), repo])
  git(repo, ['remote', 'remove', 'origin'])
  const baseSha = git(repo, ['rev-parse', 'HEAD']).trim()
  const vars = templateVars({ ...o, frameworkRef: o.frameworkRef ?? source.framework_ref ?? undefined })
  const crs = extractChangeRequests(readFileSync(join(labRoot, 'experiment', 'PHASE2.md'), 'utf8'))
  const inputs: Record<string, string> = {}
  for (const cr of crs.filter((c) => (CHANGE_REQUESTS as readonly string[]).includes(c.id))) {
    const text = renderCrKickoff(o.framework, cr, vars)
    writeText(join(dir, `kickoff-${crKey(cr.id)}.md`), text)
    inputs[`kickoff_${crKey(cr.id)}_sha256`] = sha256(text)
  }
  const meta = baseMeta({ ...o, frameworkRef: vars.FRAMEWORK_REF }, source.id, inputs)

  return { ...meta, source_run: relative(dir, o.from), base_sha: baseSha, shas: { base: baseSha } }
}

export function createRun(o: NewRunOptions): string {
  const labRoot = o.labRoot ?? LAB_ROOT
  const runsRoot = o.runsRoot ?? RUNS_ROOT
  if (resolve(runsRoot).startsWith(`${resolve(labRoot)}/`)) throw new Error(`runs root ${runsRoot} must be outside the lab repo ${labRoot}`)
  const dir = runDir(o.phase, runId(o.framework, o.model, o.n), runsRoot)
  if (existsSync(dir)) throw new Error(`${dir} already exists; runs are never reused`)
  mkdirSync(dir, { recursive: true })
  try {
    const meta = o.phase === 'phase1' ? createPhase1(o, dir, labRoot) : createPhase2(o, dir, labRoot)
    writeJson(join(dir, 'run.json'), meta)
    writeJson(join(dir, 'session-settings.json'), sessionSettings(o, labRoot, resolve(runsRoot)))
    writeFileSync(join(dir, 'launch.sh'), launchScript({ ...o, frameworkRef: meta.framework_ref ?? undefined }), { mode: 0o755 })
    grantTeamUser(dir)
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }

  return dir
}

if (import.meta.main) {
  await runMain(USAGE, async () => {
    const f = readFlags(process.argv.slice(2), {
      phase: 'string',
      framework: 'string',
      model: 'string',
      n: 'string',
      'created-at': 'string',
      'framework-ref': 'string',
      from: 'string',
      'runs-root': 'string',
      port: 'string',
    })
    const from = optional(f, 'from')
    await assertHostFree(optional(f, 'runs-root') ?? RUNS_ROOT, positiveInt(optional(f, 'port') ?? CANDIDATE_PORT, 'port'))
    const dir = createRun({
      phase: oneOf(PHASES, required(f, 'phase'), 'phase'),
      framework: oneOf(FRAMEWORKS, required(f, 'framework'), 'framework'),
      model: oneOf(MODELS, required(f, 'model'), 'model'),
      n: positiveInt(required(f, 'n'), 'n'),
      createdAt: isoTimestamp(required(f, 'created-at'), 'created-at'),
      frameworkRef: optional(f, 'framework-ref'),
      from: from ? resolve(from) : undefined,
      runsRoot: optional(f, 'runs-root'),
    })
    console.log(dir)
  })
}
