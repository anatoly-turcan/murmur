import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { parseProcessTable, treeRssPeaks, waitHealthy, type Candidate, type Processes, type Sample } from './candidate.ts'

const execFileAsync = promisify(execFile)

export const DEFAULT_IMAGE = 'node:26-bookworm-slim'
export const DEFAULT_NETWORK: Network = 'publish'
export const CONTAINER_DB_DIR = '/data'
const CONTAINER_HOME = '/home/perf'
const CGROUP = '/sys/fs/cgroup'
const MIB = 1024 * 1024

export const NETWORKS = ['host', 'publish'] as const
export type Network = (typeof NETWORKS)[number]

export interface ContainerSpec {
  image: string
  cpus: number
  memoryBytes: number
  network: Network
}

export interface ContainerInfo {
  runtime: 'docker'
  image: string
  image_id: string
  docker_version: string
  cpus: number
  memory_bytes: number
  memory_swap_bytes: number
  network: Network
}

export interface CpuStat {
  usage_usec: number
  user_usec: number
  system_usec: number
}

export interface CpuSample {
  at_ms: number
  stat: CpuStat
}

export interface CpuUsage {
  cpu_s: number
  user_s: number
  system_s: number
  elapsed_s: number
  utilisation: number
}

export interface Cgroup {
  info: ContainerInfo
  cpuStat(): Promise<CpuStat>
  memoryPeakBytes(): Promise<number | null>
}

export type ContainerCandidate = Candidate & Required<Pick<Candidate, 'cgroup'>>

interface Layout {
  repo: string
  root: string
  db: string
  home: string
}

const DB_URL_FORMS: Array<[RegExp, string]> = [
  [/^sqlite:\/\/(\/[^?]*)(\?.*)?$/, 'sqlite://'],
  [/^sqlite:([^?]*)(\?.*)?$/, 'sqlite://'],
  [/^file:\/\/(\/[^?]*)(\?.*)?$/, 'file://'],
  [/^file:([^?]*)(\?.*)?$/, 'file:'],
  [/^([^:?]+)(\?.*)?$/, ''],
]

export function containerDbUrl(url: string, dir = CONTAINER_DB_DIR): { file: string; url: string } {
  for (const [form, prefix] of DB_URL_FORMS) {
    const match = form.exec(url)
    if (!match) continue
    const file = basename(match[1] ?? '')
    if (!file || file === ':memory:') break

    return { file, url: `${prefix}${dir}/${file}${match[2] ?? ''}` }
  }
  throw new Error(`--db-url "${url}" does not name a SQLite file (sqlite:./x, sqlite:///abs, file:x or a bare path)`)
}

const UNITS: Record<string, number> = { '': 1, b: 1, k: 1024, m: MIB, g: 1024 * MIB }

export function memoryBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(value.trim())
  if (!match) throw new Error(`--memory must look like 1g or 512m, got "${value}"`)

  return Math.round(Number(match[1]) * (UNITS[(match[2] ?? '').toLowerCase()] as number))
}

export function parseCpuStat(text: string): CpuStat {
  const values = new Map(
    text
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length === 2)
      .map(([k = '', v = '']) => [k, Number(v)] as const),
  )
  const field = (name: keyof CpuStat) => {
    const v = values.get(name)
    if (v === undefined || !Number.isFinite(v)) throw new Error(`cpu.stat has no ${name}`)

    return v
  }

  return { usage_usec: field('usage_usec'), user_usec: field('user_usec'), system_usec: field('system_usec') }
}

export function parseCgroupBytes(text: string): number | null {
  const value = Number(text.trim())

  return text.trim() !== '' && Number.isFinite(value) ? value : null
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits

export function cpuUsage(before: CpuSample, after: CpuSample, cpus: number): CpuUsage {
  const seconds = (key: keyof CpuStat) => (after.stat[key] - before.stat[key]) / 1e6
  const elapsed = (after.at_ms - before.at_ms) / 1000

  return {
    cpu_s: round(seconds('usage_usec'), 3),
    user_s: round(seconds('user_usec'), 3),
    system_s: round(seconds('system_usec'), 3),
    elapsed_s: round(elapsed, 3),
    utilisation: round(seconds('usage_usec') / Math.max(elapsed * cpus, 1e-9), 4),
  }
}

export const SAMPLE_SCRIPT = [
  `cat ${CGROUP}/memory.current`,
  `grep '^anon ' ${CGROUP}/memory.stat`,
  'cd /proc',
  'for p in [0-9]*; do',
  '  { read -r stat < "$p/stat" && read -r _ rss _ < "$p/statm"; } 2>/dev/null || continue',
  '  set -- ${stat##*) }',
  '  [ "$1" = Z ] && continue',
  '  echo "$p $2 $((rss * 4))"',
  'done',
].join('\n')

export function parseSample(out: string, pids: Processes): Sample {
  const lines = out.split('\n')
  const table = parseProcessTable(out)
  const live = new Set(table.map((r) => r.pid))
  const current = parseCgroupBytes(lines[0] ?? '')
  const anon = parseCgroupBytes(lines.find((l) => l.startsWith('anon '))?.slice(5) ?? '')
  const memory = { ...(current === null ? {} : { memory_current_mib: current / MIB }), ...(anon === null ? {} : { memory_anon_mib: anon / MIB }) }

  return { values: { ...treeRssPeaks(pids, table), ...memory }, alive: { api: live.has(pids.api), worker: live.has(pids.worker) } }
}

export const ENTRY_SCRIPT = `export PATH="${CONTAINER_HOME}/bin:${CONTAINER_HOME}/tools/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0

tools() {
  command -v pnpm >/dev/null 2>&1 && return 0
  mkdir -p ${CONTAINER_HOME}/bin
  command -v corepack >/dev/null 2>&1 || (cd /tmp && npm install --global --prefix ${CONTAINER_HOME}/tools corepack >/dev/null) || return 1
  corepack enable --install-directory ${CONTAINER_HOME}/bin
}

serve() {
  trap 'kill -TERM -1 2>/dev/null; wait; exit 0' TERM INT
  ./bin/api >> /harness/api.log 2>&1 &
  api=$!
  while [ ! -e /harness/worker.go ]; do sleep 0.2; done
  ./bin/worker >> /harness/worker.log 2>&1 &
  echo "$api $!" > /harness/pids
  wait
}

tools || exit 1
case "$1" in
  setup) exec ./bin/setup ;;
  serve) serve ;;
esac
`

function userFlag(): string[] {
  const uid = process.getuid?.()
  const gid = process.getgid?.()

  return uid === undefined || gid === undefined ? [] : ['--user', `${uid}:${gid}`]
}

function networkFlags(network: Network, mode: 'setup' | 'serve', port: string): string[] {
  return mode === 'setup' || network === 'host' ? ['--network', 'host'] : ['--publish', `127.0.0.1:${port}:${port}`]
}

export function dockerRunArgs(spec: ContainerSpec, layout: Layout, env: Record<string, string>, mode: 'setup' | 'serve', name: string): string[] {
  const vars = { ...env, HOME: CONTAINER_HOME }

  return [
    'run',
    '--rm',
    ...(mode === 'serve' ? ['--detach', '--name', name] : []),
    '--label',
    'murmur-lab=perf',
    ...networkFlags(spec.network, mode, env.TASKWELL_PORT ?? ''),
    '--cpus',
    String(spec.cpus),
    '--memory',
    String(spec.memoryBytes),
    '--memory-swap',
    String(spec.memoryBytes),
    ...userFlag(),
    '--volume',
    `${layout.repo}:/app`,
    '--volume',
    `${layout.db}:${CONTAINER_DB_DIR}`,
    '--volume',
    `${layout.root}:/harness`,
    '--volume',
    `${layout.home}:${CONTAINER_HOME}`,
    '--workdir',
    '/app',
    ...Object.entries(vars).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    spec.image,
    'sh',
    '/harness/entry.sh',
    mode,
  ]
}

function docker(args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${(r.stderr || r.stdout || '').trim()}`)

  return r.stdout.trim()
}

function ensureImage(image: string): string {
  try {
    return docker(['image', 'inspect', '--format', '{{.Id}}', image])
  } catch {
    docker(['pull', '--quiet', image])

    return docker(['image', 'inspect', '--format', '{{.Id}}', image])
  }
}

function prepareLayout(repo: string, runDir: string): Layout {
  const root = join(runDir, 'perf-container')
  const db = join(runDir, 'perf-db')
  const home = join(root, 'home')
  rmSync(db, { recursive: true, force: true })
  for (const f of ['pids', 'worker.go', 'api.log', 'worker.log']) rmSync(join(root, f), { force: true })
  for (const dir of [root, db, home]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'entry.sh'), ENTRY_SCRIPT)

  return { repo, root, db, home }
}

async function readPids(file: string, timeoutMs: number): Promise<Processes> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [api, worker] = existsSync(file) ? readFileSync(file, 'utf8').trim().split(/\s+/).map(Number) : []
    if (api && worker) return { api, worker }
    await sleep(100)
  }
  throw new Error(`${file} not written within ${timeoutMs} ms`)
}

function stopContainer(id: string): void {
  const stopped = spawnSync('docker', ['stop', '--time', '10', id], { stdio: 'ignore' })
  if (stopped.status !== 0) spawnSync('docker', ['kill', id], { stdio: 'ignore' })
}

function running(id: string): boolean {
  return spawnSync('docker', ['container', 'inspect', '--format', '{{.State.Running}}', id], { encoding: 'utf8' }).stdout?.trim() === 'true'
}

function sampler(id: string, pids: Processes, exec: (args: string[]) => Promise<string>): () => Promise<Sample> {
  return async () => {
    try {
      return parseSample(await exec(['sh', '-c', SAMPLE_SCRIPT]), pids)
    } catch (error) {
      if (running(id)) throw error

      return { values: {}, alive: { api: false, worker: false } }
    }
  }
}

function cgroupOf(id: string, info: ContainerInfo): { cgroup: Cgroup; exec(args: string[]): Promise<string> } {
  const exec = async (args: string[]) => (await execFileAsync('docker', ['exec', id, ...args], { encoding: 'utf8', maxBuffer: 16 * MIB })).stdout
  const memoryPeakBytes = async () => {
    try {
      return parseCgroupBytes(await exec(['cat', `${CGROUP}/memory.peak`]))
    } catch {
      return null
    }
  }

  return { exec, cgroup: { info, cpuStat: async () => parseCpuStat(await exec(['cat', `${CGROUP}/cpu.stat`])), memoryPeakBytes } }
}

async function serve(spec: ContainerSpec, layout: Layout, env: Record<string, string>, info: ContainerInfo): Promise<ContainerCandidate> {
  const id = docker(dockerRunArgs(spec, layout, env, 'serve', `murmur-lab-perf-${env.TASKWELL_PORT}`))
  try {
    await waitHealthy(`http://127.0.0.1:${env.TASKWELL_PORT}/healthz`, 30_000).catch((error: Error) => {
      throw new Error(`${error.message}; see ${layout.root}/api.log${spec.network === 'host' ? '; on Docker Desktop host-network ports reach the host only with "Enable host networking" on (else use --network publish)' : ''}`)
    })
    writeFileSync(join(layout.root, 'worker.go'), '')
    const pids = await readPids(join(layout.root, 'pids'), 10_000)
    const { exec, cgroup } = cgroupOf(id, info)
    await cgroup.cpuStat()

    const logs = { api: join(layout.root, 'api.log'), worker: join(layout.root, 'worker.log') }

    return { pids, logs, cgroup, sample: sampler(id, pids, exec), stop: async () => stopContainer(id) }
  } catch (error) {
    stopContainer(id)
    throw error
  }
}

export async function startContainer(repo: string, env: Record<string, string>, runDir: string, spec: ContainerSpec): Promise<ContainerCandidate> {
  const imageId = ensureImage(spec.image)
  const db = containerDbUrl(env.TASKWELL_DATABASE_URL ?? '')
  const layout = prepareLayout(repo, runDir)
  const containerEnv = { ...env, TASKWELL_DATABASE_URL: db.url }
  const setup = spawnSync('docker', dockerRunArgs(spec, layout, containerEnv, 'setup', ''), { stdio: 'inherit' })
  if (setup.status !== 0) throw new Error(`./bin/setup in ${spec.image} exited ${setup.status}`)
  const info: ContainerInfo = {
    runtime: 'docker',
    image: spec.image,
    image_id: imageId,
    docker_version: docker(['version', '--format', '{{.Server.Version}}']),
    cpus: spec.cpus,
    memory_bytes: spec.memoryBytes,
    memory_swap_bytes: spec.memoryBytes,
    network: spec.network,
  }

  return serve(spec, layout, containerEnv, info)
}
