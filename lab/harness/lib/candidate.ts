import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { openSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { CANDIDATE_PORT } from './arms.ts'
import type { Cgroup } from './container.ts'

export type Peaks = Record<string, number>
export type ProcessName = 'api' | 'worker'
export type Processes = Record<ProcessName, number>
export type Liveness = Record<ProcessName, boolean>

export interface Sample {
  values: Peaks
  alive: Liveness
}

export interface Candidate {
  pids: Processes
  logs: Record<ProcessName, string>
  cgroup?: Cgroup
  sample(): Promise<Sample>
  stop(): Promise<void>
}

export interface ProcessRow {
  pid: number
  ppid: number
  rssKiB: number
}

function launch(repo: string, command: string, env: NodeJS.ProcessEnv, log: string): ChildProcess {
  const out = openSync(log, 'w')

  return spawn(command, [], { cwd: repo, env, detached: true, stdio: ['ignore', out, out] })
}

export async function waitHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error(`${url} not healthy within ${timeoutMs} ms`)
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null

async function terminate(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  process.kill(-child.pid, 'SIGTERM')
  const timedOut = await Promise.race([exited.then(() => false), sleep(5000).then(() => true)])
  if (timedOut) process.kill(-child.pid, 'SIGKILL')
}

export async function startCandidate(repo: string, env: Record<string, string>, logDir: string): Promise<Candidate> {
  const fullEnv = { ...process.env, ...env }
  const setup = spawnSync('./bin/setup', [], { cwd: repo, env: fullEnv, stdio: 'inherit' })
  if (setup.status !== 0) throw new Error(`./bin/setup exited ${setup.status}`)
  const logs = { api: join(logDir, 'perf-api.log'), worker: join(logDir, 'perf-worker.log') }
  const api = launch(repo, './bin/api', fullEnv, logs.api)
  await waitHealthy(`http://127.0.0.1:${env.TASKWELL_PORT ?? CANDIDATE_PORT}/healthz`, 15_000)
  const worker = launch(repo, './bin/worker', fullEnv, logs.worker)
  const pids = { api: api.pid ?? -1, worker: worker.pid ?? -1 }

  return {
    pids,
    logs,
    sample: async () => ({ values: treeRssPeaks(pids, processTable()), alive: { api: running(api), worker: running(worker) } }),
    stop: async () => {
      await Promise.all([terminate(api), terminate(worker)])
    },
  }
}

export function parseProcessTable(out: string): ProcessRow[] {
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((r) => r.length === 3 && r.every((n) => Number.isFinite(n)))
    .map(([pid = 0, ppid = 0, rssKiB = 0]) => ({ pid, ppid, rssKiB }))
}

export function processTable(): ProcessRow[] {
  return parseProcessTable(spawnSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).stdout)
}

export function treeRssMiB(rootPid: number, table = processTable()): number {
  const inTree = new Set([rootPid])
  let grew = true
  while (grew) {
    grew = false
    for (const row of table) {
      if (!inTree.has(row.pid) && inTree.has(row.ppid)) {
        inTree.add(row.pid)
        grew = true
      }
    }
  }

  return table.filter((r) => inTree.has(r.pid)).reduce((sum, r) => sum + r.rssKiB, 0) / 1024
}

export function treeRssPeaks(pids: Record<string, number>, table: ProcessRow[]): Peaks {
  return Object.fromEntries(Object.entries(pids).map(([name, pid]) => [name, treeRssMiB(pid, table)]))
}

export interface Sampler {
  trackPeaks(): void
  stop(): Promise<Peaks>
}

export function startSampler(read: () => Promise<Sample>, onAlive: (alive: Liveness) => void, intervalMs = 1000): Sampler {
  const peak: Peaks = {}
  let tracking = false
  let inFlight: Promise<void> | undefined
  const tick = async () => {
    try {
      const sample = await read()
      onAlive(sample.alive)
      if (tracking) for (const [k, v] of Object.entries(sample.values)) peak[k] = Math.max(peak[k] ?? 0, v)
    } catch {}
  }
  const timer = setInterval(() => {
    inFlight ??= tick().finally(() => (inFlight = undefined))
  }, intervalMs)
  timer.unref()

  return {
    trackPeaks: () => {
      tracking = true
    },
    stop: async () => {
      clearInterval(timer)
      await inFlight

      return peak
    },
  }
}
