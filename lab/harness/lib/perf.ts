import { percentile, type LoadResult } from './pacer.ts'
import { median } from './stats.ts'

export type TargetKey = 'get_single' | 'list' | 'search' | 'write' | 'summary'

export interface Target {
  key: TargetKey
  label: string
  p99_ms: number
  rps: number
  // share of requests a SPEC-conformant server may count in the key-general bucket (GET /v1/workspaces/{id} is arguably not workspace-scoped)
  general_share: number
}

export const TARGETS: Target[] = [
  { key: 'get_single', label: 'GET single object', p99_ms: 50, rps: 500, general_share: 1 / 3 },
  { key: 'list', label: 'List, limit=50, filters', p99_ms: 300, rps: 500, general_share: 0 },
  { key: 'search', label: 'Workspace search', p99_ms: 800, rps: 100, general_share: 0 },
  { key: 'write', label: 'POST/PATCH task or comment', p99_ms: 150, rps: 200, general_share: 0 },
  { key: 'summary', label: 'Project summary, 2,000 tasks', p99_ms: 300, rps: 100, general_share: 0 },
]

export const MAX_INVALID_SHARE = 0.01
export const HEADROOM = 2
export const RATE_LIMITS = {
  ip_authenticated: 1200,
  key_general: 120,
  role: { owner: 600, admin: 600, member: 300, viewer: 60 } as Record<string, number>,
}

export interface Identity {
  email: string
  keys: string[]
  roles: Record<string, string>
}

export interface WorkspaceData {
  id: string
  projects: string[]
  tasks: string[]
}

export interface Pool {
  identities: Identity[]
  workspaces: WorkspaceData[]
  summary_project: { id: string; workspace_id: string; tasks: number } | null
  search_terms: string[]
}

export interface PlannedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}

export interface Slot {
  key: string
  ip: string
  workspace: WorkspaceData
  role: string
  per_minute: number
}

export interface ClassPlan {
  target: Target
  slots: Slot[]
  capacity_rps: number
  planned_rps: number
}

export interface TargetResult {
  planned_rps: number
  rps: number
  p50_ms: number
  p95_ms: number
  p99_ms: number
  max_ms: number
  error_rate: number
  requests: number
  ok_2xx: number
  rate_limited: number
  client_errors: number
  server_errors: number
  errors: number
  timeouts: number
  max_lag_ms: number
  loop_delay_max_ms: number
  loop_delay_p99_ms: number
  target_p99_ms: number
  met: boolean
  valid: boolean
}

export type Rng = () => number

const WRITER_ROLES = ['owner', 'admin', 'member']
const FILTERS = ['status=open,in_progress', 'overdue=true', 'assignee_id=none', 'due_after=2026-01-01']
const SORTS = ['', 'sort=due_date', 'sort=updated_at']

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('cannot pick from an empty list')

  return items[Math.floor(rng() * items.length)] as T
}

export function roundRobin(weights: number[]): () => number {
  if (weights.length === 0 || !weights.every((w) => w > 0)) throw new Error('round robin needs positive weights')
  const total = sum(weights)
  const current = weights.map(() => 0)

  return () => {
    let best = 0
    for (let i = 0; i < weights.length; i += 1) {
      current[i] = (current[i] as number) + (weights[i] as number)
      if ((current[i] as number) > (current[best] as number)) best = i
    }
    current[best] = (current[best] as number) - total

    return best
  }
}

export function keyIp(index: number): string {
  return `10.${100 + Math.floor(index / 65536)}.${(index >> 8) & 255}.${index & 255}`
}

function poolKeys(pool: Pool): Array<{ identity: Identity; key: string; ip: string }> {
  return pool.identities.flatMap((identity) => identity.keys.map((key) => ({ identity, key }))).map((k, i) => ({ ...k, ip: keyIp(i) }))
}

function classWorkspaces(pool: Pool, key: TargetKey): WorkspaceData[] {
  if (key !== 'summary') return pool.workspaces.filter((w) => w.tasks.length > 0 && w.projects.length > 0)
  const target = pool.summary_project
  if (!target) throw new Error('no summary project discovered')

  return pool.workspaces.filter((w) => w.id === target.workspace_id)
}

function keyCap(target: Target): number {
  const ip = RATE_LIMITS.ip_authenticated

  return target.general_share > 0 ? Math.min(ip, RATE_LIMITS.key_general / target.general_share) : ip
}

export function slotsFor(pool: Pool, target: Target): Slot[] {
  const workspaces = classWorkspaces(pool, target.key)
  const roles = target.key === 'write' ? WRITER_ROLES : Object.keys(RATE_LIMITS.role)

  return poolKeys(pool).flatMap(({ identity, key, ip }) => {
    const own = workspaces
      .map((workspace) => ({ workspace, role: identity.roles[workspace.id] ?? '' }))
      .filter((s) => roles.includes(s.role))
      .map((s) => ({ key, ip, ...s, per_minute: RATE_LIMITS.role[s.role] as number }))
    const scale = Math.min(1, keyCap(target) / Math.max(sum(own.map((s) => s.per_minute)), 1))

    return own.map((s) => ({ ...s, per_minute: s.per_minute * scale }))
  })
}

export function planClass(pool: Pool, target: Target): ClassPlan {
  const slots = slotsFor(pool, target)
  const capacity = sum(slots.map((s) => s.per_minute)) / 60
  const planned = Math.min(target.rps, Math.floor(capacity / HEADROOM))
  if (planned < 1) throw new Error(`pool cannot carry ${target.key}: capacity ${capacity.toFixed(2)} req/s`)

  return { target, slots, capacity_rps: Math.round(capacity * 100) / 100, planned_rps: planned }
}

export function planLoad(pool: Pool): ClassPlan[] {
  return TARGETS.map((t) => planClass(pool, t))
}

export function warmupRps(plans: ClassPlan[]): number {
  const utilisation = sum(plans.map((p) => p.planned_rps / p.capacity_rps))
  const scale = Math.min(1, 1 / (HEADROOM * utilisation))

  return Math.max(1, Math.floor(scale * sum(plans.map((p) => p.planned_rps))))
}

function headers(slot: Slot, json: boolean): Record<string, string> {
  const base = { authorization: `Bearer ${slot.key}`, 'x-forwarded-for': slot.ip }

  return json ? { ...base, 'content-type': 'application/json' } : base
}

function get(slot: Slot, path: string): PlannedRequest {
  return { method: 'GET', path, headers: headers(slot, false) }
}

function send(slot: Slot, method: string, path: string, body: object): PlannedRequest {
  return { method, path, headers: headers(slot, true), body: JSON.stringify(body) }
}

export function filterQuery(rng: Rng): string {
  const filters = FILTERS.filter(() => rng() < 0.3)
  const sort = pick(rng, SORTS)

  return ['limit=50', ...filters, ...(sort ? [sort] : [])].join('&')
}

function getSingle(slot: Slot, rng: Rng): PlannedRequest {
  const w = slot.workspace
  const paths = [`/v1/tasks/${pick(rng, w.tasks)}`, `/v1/projects/${pick(rng, w.projects)}`, `/v1/workspaces/${w.id}`]

  return get(slot, pick(rng, paths))
}

function list(slot: Slot, rng: Rng): PlannedRequest {
  const w = slot.workspace
  const paths = [
    `/v1/projects/${pick(rng, w.projects)}/tasks?${filterQuery(rng)}`,
    `/v1/workspaces/${w.id}/tasks?${filterQuery(rng)}`,
    `/v1/workspaces/${w.id}/activity?limit=50`,
    `/v1/tasks/${pick(rng, w.tasks)}/comments?limit=50`,
  ]

  return get(slot, pick(rng, paths))
}

function search(slot: Slot, pool: Pool, rng: Rng): PlannedRequest {
  return get(slot, `/v1/workspaces/${slot.workspace.id}/search?q=${encodeURIComponent(pick(rng, pool.search_terms))}&limit=50`)
}

function write(slot: Slot, rng: Rng, seq: number): PlannedRequest {
  const w = slot.workspace
  const choice = Math.floor(rng() * 3)
  if (choice === 0) return send(slot, 'POST', `/v1/projects/${pick(rng, w.projects)}/tasks`, { title: `load task ${seq}`, labels: ['load'], estimate_minutes: 30 })
  if (choice === 1) return send(slot, 'PATCH', `/v1/tasks/${pick(rng, w.tasks)}`, { title: `load edit ${seq}` })

  return send(slot, 'POST', `/v1/tasks/${pick(rng, w.tasks)}/comments`, { body: `load comment ${seq}` })
}

function summary(slot: Slot, pool: Pool): PlannedRequest {
  return get(slot, `/v1/projects/${pool.summary_project?.id}/summary`)
}

export function buildRequest(key: TargetKey, pool: Pool, slot: Slot, rng: Rng, seq: number): PlannedRequest {
  if (key === 'get_single') return getSingle(slot, rng)
  if (key === 'list') return list(slot, rng)
  if (key === 'search') return search(slot, pool, rng)
  if (key === 'write') return write(slot, rng, seq)

  return summary(slot, pool)
}

export function classSource(plan: ClassPlan, pool: Pool, rng: Rng): (seq: number) => PlannedRequest {
  const next = roundRobin(plan.slots.map((s) => s.per_minute))

  return (seq) => buildRequest(plan.target.key, pool, plan.slots[next()] as Slot, rng, seq)
}

export function mixedSource(plans: ClassPlan[], pool: Pool, rng: Rng): (seq: number) => PlannedRequest {
  const sources = plans.map((p) => classSource(p, pool, rng))
  const next = roundRobin(plans.map((p) => p.planned_rps))

  return (seq) => (sources[next()] as (seq: number) => PlannedRequest)(seq)
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits

function countWhere(status: Record<string, number>, test: (code: number) => boolean): number {
  return sum(Object.entries(status).map(([code, n]) => (test(Number(code)) ? n : 0)))
}

type Outcomes = Pick<TargetResult, 'requests' | 'ok_2xx' | 'errors' | 'timeouts'>

const failures = (r: Outcomes) => r.requests - r.ok_2xx + r.errors + r.timeouts
const attempts = (r: Outcomes) => r.requests + r.errors + r.timeouts

export function errorRate(reps: Outcomes[]): number {
  return round(sum(reps.map(failures)) / Math.max(sum(reps.map(attempts)), 1), 6)
}

export function summarize(result: LoadResult, target: Target, plannedRps: number): TargetResult {
  const requests = countWhere(result.status, () => true)
  const ok = countWhere(result.status, (c) => c >= 200 && c < 300)
  const rateLimited = result.status['429'] ?? 0
  const clientErrors = countWhere(result.status, (c) => c >= 400 && c < 500) - rateLimited
  const serverErrors = countWhere(result.status, (c) => c >= 500)
  const invalid = requests - ok + result.errors + result.timeouts
  const sorted = [...result.latencies_ms].sort((a, b) => a - b)
  const p99 = round(percentile(sorted, 99), 1)

  return {
    planned_rps: plannedRps,
    rps: round(requests / Math.max(result.elapsed_s, 1e-9), 2),
    p50_ms: round(percentile(sorted, 50), 1),
    p95_ms: round(percentile(sorted, 95), 1),
    p99_ms: p99,
    max_ms: round(sorted.at(-1) ?? 0, 1),
    error_rate: errorRate([{ requests, ok_2xx: ok, errors: result.errors, timeouts: result.timeouts }]),
    requests,
    ok_2xx: ok,
    rate_limited: rateLimited,
    client_errors: clientErrors,
    server_errors: serverErrors,
    errors: result.errors,
    timeouts: result.timeouts,
    max_lag_ms: round(result.max_lag_ms, 1),
    loop_delay_max_ms: round(result.loop_delay_max_ms, 1),
    loop_delay_p99_ms: round(result.loop_delay_p99_ms, 1),
    target_p99_ms: target.p99_ms,
    met: p99 <= target.p99_ms,
    valid: requests > 0 && invalid / Math.max(requests, 1) <= MAX_INVALID_SHARE,
  }
}

export function combineReps(reps: TargetResult[], targetP99Ms: number): TargetResult {
  if (reps.length === 0) throw new Error('no reps to combine')
  const p99 = median(reps.map((r) => r.p99_ms))
  const middle = reps.reduce((best, r) => (Math.abs(r.p99_ms - p99) < Math.abs(best.p99_ms - p99) ? r : best))

  return {
    ...middle,
    p50_ms: median(reps.map((r) => r.p50_ms)),
    p95_ms: median(reps.map((r) => r.p95_ms)),
    p99_ms: p99,
    max_ms: Math.max(...reps.map((r) => r.max_ms)),
    error_rate: errorRate(reps),
    rps: median(reps.map((r) => r.rps)),
    met: p99 <= targetP99Ms,
    valid: reps.every((r) => r.valid),
  }
}

export function searchTerms(titles: string[], limit = 200): string[] {
  const words = titles.flatMap((t) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 3)
  const unique = [...new Set(words.map((w) => w.slice(0, Math.min(w.length, 6))))]

  return unique.length > 0 ? unique.slice(0, limit) : ['task', 'fix', 'the']
}
