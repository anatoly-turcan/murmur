import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { optional, positiveInt, readFlags, runMain, type FlagValues } from './lib/cli.ts'
import { startCandidate, startSampler, type Candidate, type Peaks } from './lib/candidate.ts'
import { DEFAULT_IMAGE, DEFAULT_NETWORK, NETWORKS, cpuUsage, memoryBytes, startContainer, type Cgroup, type CpuSample, type CpuUsage, type Network } from './lib/container.ts'
import { CANDIDATE_PORT, RUNS_ROOT, oneOf } from './lib/arms.ts'
import { assertHostFree } from './lib/guard.ts'
import { candidateReport, invalidReason, liveness } from './lib/liveness.ts'
import { readJson, writeJson } from './lib/io.ts'
import { HEADROOM, RATE_LIMITS, classSource, combineReps, mixedSource, planLoad, summarize, warmupRps, type ClassPlan, type PlannedRequest, type Pool, type TargetResult } from './lib/perf.ts'
import { runPaced } from './lib/pacer.ts'
import { discover, seedReference, type SeedUser } from './lib/taskwell.ts'

const SETTLE_MS = 3000

const USAGE =
  'node measure-perf.ts --out <run dir>/perf.json [--repo <candidate repo> --db-url <url> [--port 8085] [--cpus 2] [--memory 1g] [--image node:26-bookworm-slim] [--network publish|host] [--no-container]] [--base-url http://127.0.0.1:8085] [--seed-file <seed.json>] [--warmup 120] [--duration 60] [--connections 50] [--reps 3] [--keys-per-user 20]'

interface Settings {
  out: string
  baseUrl: string
  repo?: string
  dbUrl?: string
  port: string
  seedFile?: string
  warmup: number
  duration: number
  connections: number
  reps: number
  keysPerUser: number
  container: boolean
  image: string
  cpus: number
  memoryBytes: number
  network: Network
}

type Liveness = ReturnType<typeof liveness>
type ClassResult = TargetResult & { capacity_rps: number; cpu: CpuUsage | null; reps: TargetResult[] }

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive number, got "${value}"`)

  return parsed
}

function settings(f: FlagValues): Settings {
  const port = optional(f, 'port') ?? CANDIDATE_PORT
  const num = (name: string, fallback: number) => positiveInt(optional(f, name) ?? String(fallback), name)
  const out = optional(f, 'out')
  if (!out) throw new Error('--out is required')

  return {
    out: resolve(out),
    baseUrl: optional(f, 'base-url') ?? `http://127.0.0.1:${port}`,
    repo: optional(f, 'repo'),
    dbUrl: optional(f, 'db-url'),
    port,
    seedFile: optional(f, 'seed-file'),
    warmup: num('warmup', 120),
    duration: num('duration', 60),
    connections: num('connections', 50),
    reps: num('reps', 3),
    keysPerUser: num('keys-per-user', 20),
    container: f['no-container'] !== true,
    image: optional(f, 'image') ?? DEFAULT_IMAGE,
    cpus: positiveNumber(optional(f, 'cpus') ?? '2', 'cpus'),
    memoryBytes: memoryBytes(optional(f, 'memory') ?? '1g'),
    network: oneOf(NETWORKS, optional(f, 'network') ?? DEFAULT_NETWORK, 'network'),
  }
}

function load(s: Settings, duration: number, rate: number, build: (seq: number) => PlannedRequest) {
  return runPaced({ baseUrl: s.baseUrl, rate, durationS: duration, connections: s.connections, timeoutMs: 10_000, build })
}

async function cpuSample(cgroup: Cgroup | undefined): Promise<CpuSample | undefined> {
  return cgroup ? { at_ms: performance.now(), stat: await cgroup.cpuStat() } : undefined
}

function usage(before: CpuSample | undefined, after: CpuSample | undefined, cpus: number): CpuUsage | null {
  return before && after ? cpuUsage(before, after, cpus) : null
}

async function measureTarget(s: Settings, pool: Pool, plan: ClassPlan, cgroup: Cgroup | undefined): Promise<ClassResult> {
  const reps: TargetResult[] = []
  const before = await cpuSample(cgroup)
  for (let i = 0; i < s.reps; i += 1) {
    const result = await load(s, s.duration, plan.planned_rps, classSource(plan, pool, Math.random))
    reps.push(summarize(result, plan.target, plan.planned_rps))
  }
  const after = await cpuSample(cgroup)

  return { ...combineReps(reps, plan.target.p99_ms), capacity_rps: plan.capacity_rps, cpu: usage(before, after, s.cpus), reps }
}

function containerEnv(s: Settings): Record<string, string> {
  if (!s.dbUrl) throw new Error('--db-url is required with --repo')

  return {
    TASKWELL_DATABASE_URL: s.dbUrl,
    TASKWELL_PORT: s.port,
    TASKWELL_TEST_MODE: 'true',
    TASKWELL_TRUST_PROXY: 'true',
    TASKWELL_LOG_LEVEL: 'warn',
  }
}

async function startIfRequested(s: Settings): Promise<Candidate | undefined> {
  if (!s.repo) return undefined
  const env = containerEnv(s)
  await assertHostFree(RUNS_ROOT, Number(s.port))
  mkdirSync(dirname(s.out), { recursive: true })
  if (!s.container) return startCandidate(resolve(s.repo), env, dirname(s.out))

  return startContainer(resolve(s.repo), env, dirname(s.out), { image: s.image, cpus: s.cpus, memoryBytes: s.memoryBytes, network: s.network })
}

async function seedUsers(s: Settings): Promise<SeedUser[]> {
  if (s.seedFile) return readJson<SeedUser[]>(s.seedFile)
  const users = await seedReference(s.baseUrl)
  writeJson(join(dirname(s.out), 'seed.json'), users)

  return users
}

function poolStats(pool: Pool) {
  return {
    identities: pool.identities.length,
    keys: pool.identities.reduce((n, i) => n + i.keys.length, 0),
    workspaces: pool.workspaces.length,
    projects: pool.workspaces.reduce((n, w) => n + w.projects.length, 0),
    sampled_tasks: pool.workspaces.reduce((n, w) => n + w.tasks.length, 0),
    summary_project_tasks: pool.summary_project?.tasks ?? 0,
    search_terms: pool.search_terms.length,
  }
}

function loadModel(plans: ClassPlan[], warmup: number) {
  return {
    pacing: 'smooth',
    headroom: HEADROOM,
    rate_limits: RATE_LIMITS,
    warmup_rps: warmup,
    classes: Object.fromEntries(
      plans.map((p) => [
        p.target.key,
        { slots: p.slots.length, keys: new Set(p.slots.map((x) => x.key)).size, capacity_rps: p.capacity_rps, planned_rps: p.planned_rps },
      ]),
    ),
  }
}

const mib = (n: number) => Math.round(n * 10) / 10

function rssPeaks(peaks: Peaks | undefined) {
  return peaks ? { api: mib(peaks.api ?? 0), worker: mib(peaks.worker ?? 0) } : null
}

async function memorySummary(cgroup: Cgroup | undefined, peaks: Peaks | undefined) {
  if (!cgroup) return null
  const peak = await cgroup.memoryPeakBytes()
  const sampled = peaks?.memory_current_mib ?? 0

  return {
    peak_mib: peak === null ? mib(sampled) : mib(peak / 1024 / 1024),
    source: peak === null ? 'memory.current sampled at 1 s' : 'memory.peak',
    current_max_mib: mib(sampled),
    anon_max_mib: mib(peaks?.memory_anon_mib ?? 0),
  }
}

async function observeNow(candidate: Candidate | undefined, live: Liveness): Promise<void> {
  if (!candidate) return
  const sample = await candidate.sample().catch(() => undefined)
  if (sample) live.observe(sample.alive)
}

async function runClasses(s: Settings, pool: Pool, plans: ClassPlan[], cgroup: Cgroup | undefined, live: Liveness): Promise<Record<string, ClassResult>> {
  const targets: Record<string, ClassResult> = {}
  for (const plan of plans) {
    live.enter(plan.target.key)
    targets[plan.target.key] = await measureTarget(s, pool, plan, cgroup)
  }

  return targets
}

async function measure(s: Settings, candidate: Candidate | undefined) {
  const cgroup = candidate?.cgroup
  const live = liveness()
  const sampler = candidate ? startSampler(candidate.sample, live.observe) : undefined
  if (candidate) await sleep(SETTLE_MS)
  await observeNow(candidate, live)
  const startedAt = new Date().toISOString()
  const seedStart = Date.now()
  live.enter('seed')
  const pool = await discover(s.baseUrl, await seedUsers(s), s.keysPerUser)
  const seedSeconds = (Date.now() - seedStart) / 1000
  const plans = planLoad(pool)
  const warmup = warmupRps(plans)
  sampler?.trackPeaks()
  live.enter('warmup')
  const start = await cpuSample(cgroup)
  await load(s, s.warmup, warmup, mixedSource(plans, pool, Math.random))
  const warmed = await cpuSample(cgroup)
  const targets = await runClasses(s, pool, plans, cgroup, live)
  const end = await cpuSample(cgroup)
  await observeNow(candidate, live)
  const peaks = await sampler?.stop()
  const results = Object.values(targets)
  const reason = invalidReason(
    live.exits,
    Object.entries(targets).filter(([, r]) => !r.valid).map(([k]) => k),
  )

  return {
    schema: 3,
    base_url: s.baseUrl,
    autocannon: null,
    node: process.version,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    warmup_s: s.warmup,
    duration_s: s.duration,
    connections: s.connections,
    reps: s.reps,
    seed_and_discovery_s: seedSeconds,
    container: cgroup?.info ?? null,
    candidate: candidate ? candidateReport(live.exits, candidate.logs) : null,
    pool: poolStats(pool),
    load: loadModel(plans, warmup),
    targets,
    targets_met: results.filter((r) => r.met).length,
    valid: reason === null,
    invalid_reason: reason,
    cpu: cgroup ? { warmup: usage(start, warmed, s.cpus), total: usage(start, end, s.cpus) } : null,
    memory: await memorySummary(cgroup, peaks),
    rss_max_mib: rssPeaks(peaks),
  }
}

function brief(perf: Awaited<ReturnType<typeof measure>>) {
  const targets = Object.fromEntries(
    Object.entries(perf.targets).map(([k, t]) => [
      k,
      { planned_rps: t.planned_rps, rps: t.rps, p50_ms: t.p50_ms, p95_ms: t.p95_ms, p99_ms: t.p99_ms, max_ms: t.max_ms, error_rate: t.error_rate, met: t.met, valid: t.valid, cpu: t.cpu },
    ]),
  )

  return { targets_met: perf.targets_met, valid: perf.valid, invalid_reason: perf.invalid_reason, candidate: perf.candidate, container: perf.container, targets, cpu: perf.cpu, memory: perf.memory, rss_max_mib: perf.rss_max_mib }
}

if (import.meta.main) {
  await runMain(USAGE, async () => {
    const f = readFlags(process.argv.slice(2), {
      out: 'string',
      'base-url': 'string',
      repo: 'string',
      'db-url': 'string',
      port: 'string',
      'seed-file': 'string',
      warmup: 'string',
      duration: 'string',
      connections: 'string',
      reps: 'string',
      'keys-per-user': 'string',
      'no-container': 'boolean',
      image: 'string',
      cpus: 'string',
      memory: 'string',
      network: 'string',
    })
    const s = settings(f)
    const candidate = await startIfRequested(s)
    try {
      const perf = await measure(s, candidate)
      writeJson(s.out, perf)
      console.log(JSON.stringify(brief(perf), null, 2))
    } finally {
      await candidate?.stop()
    }
  })
}
