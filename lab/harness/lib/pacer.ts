import { Agent, request } from 'node:http'
import { monitorEventLoopDelay, performance, type ELDHistogram } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import type { PlannedRequest } from './perf.ts'

export interface PacedOptions {
  baseUrl: string
  rate: number
  durationS: number
  connections: number
  timeoutMs: number
  build: (seq: number) => PlannedRequest
}

export interface LoadResult {
  scheduled: number
  elapsed_s: number
  latencies_ms: number[]
  status: Record<string, number>
  errors: number
  timeouts: number
  max_lag_ms: number
  loop_delay_max_ms: number
  loop_delay_p99_ms: number
}

type Outcome = { kind: 'response'; status: number } | { kind: 'timeout' } | { kind: 'error' }

interface RunState {
  start: number
  end: number
  next: number
  result: LoadResult
}

export function scheduledAt(start: number, rate: number, seq: number): number {
  return start + (seq * 1000) / rate
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))

  return sorted[rank - 1] as number
}

function send(baseUrl: string, agent: Agent, req: PlannedRequest, timeoutMs: number): Promise<Outcome> {
  const headers = req.body === undefined ? req.headers : { ...req.headers, 'content-length': String(Buffer.byteLength(req.body)) }

  return new Promise((resolve) => {
    let settled = false
    const done = (o: Outcome) => {
      if (settled) return
      settled = true
      resolve(o)
    }
    const r = request(new URL(req.path, baseUrl), { method: req.method, headers, agent }, (res) => {
      res.on('end', () => done({ kind: 'response', status: res.statusCode ?? 0 }))
      res.on('error', () => done({ kind: 'error' }))
      res.resume()
    })
    r.setTimeout(timeoutMs, () => {
      done({ kind: 'timeout' })
      r.destroy()
    })
    r.on('error', () => done({ kind: 'error' }))
    r.end(req.body)
  })
}

function record(result: LoadResult, outcome: Outcome, due: number): void {
  if (outcome.kind === 'timeout') result.timeouts += 1
  if (outcome.kind === 'error') result.errors += 1
  if (outcome.kind !== 'response') return
  result.status[outcome.status] = (result.status[outcome.status] ?? 0) + 1
  if (outcome.status >= 200 && outcome.status < 300) result.latencies_ms.push(performance.now() - due)
}

async function connection(state: RunState, o: PacedOptions, agent: Agent): Promise<void> {
  for (;;) {
    const seq = state.next
    const due = scheduledAt(state.start, o.rate, seq)
    if (due >= state.end) return
    state.next += 1
    const req = o.build(seq)
    const wait = due - performance.now()
    if (wait > 0) await sleep(wait)
    state.result.max_lag_ms = Math.max(state.result.max_lag_ms, performance.now() - due)
    record(state.result, await send(o.baseUrl, agent, req, o.timeoutMs), due)
  }
}

function loopDelay(h: ELDHistogram): Pick<LoadResult, 'loop_delay_max_ms' | 'loop_delay_p99_ms'> {
  const ms = (ns: number) => (Number.isFinite(ns) && h.count > 0 ? ns / 1e6 : 0)

  return { loop_delay_max_ms: ms(h.max), loop_delay_p99_ms: ms(h.percentile(99)) }
}

export async function runPaced(o: PacedOptions): Promise<LoadResult> {
  const agent = new Agent({ keepAlive: true, maxSockets: o.connections })
  const loop = monitorEventLoopDelay({ resolution: 5 })
  const start = performance.now() + 50
  const result: LoadResult = { scheduled: 0, elapsed_s: 0, latencies_ms: [], status: {}, errors: 0, timeouts: 0, max_lag_ms: 0, loop_delay_max_ms: 0, loop_delay_p99_ms: 0 }
  const state: RunState = { start, end: start + o.durationS * 1000, next: 0, result }
  loop.enable()
  try {
    await Promise.all(Array.from({ length: o.connections }, () => connection(state, o, agent)))
  } finally {
    loop.disable()
    agent.destroy()
  }

  return { ...result, ...loopDelay(loop), scheduled: state.next, elapsed_s: (performance.now() - start) / 1000 }
}
