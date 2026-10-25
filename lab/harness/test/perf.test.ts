import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LoadResult } from '../lib/pacer.ts'
import {
  HEADROOM,
  RATE_LIMITS,
  TARGETS,
  classSource,
  combineReps,
  filterQuery,
  mixedSource,
  planClass,
  planLoad,
  roundRobin,
  searchTerms,
  slotsFor,
  summarize,
  warmupRps,
  type Pool,
  type Target,
  type TargetKey,
} from '../lib/perf.ts'
import { treeRssMiB } from '../lib/candidate.ts'

const keys = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `twl_${prefix}${i}`)

const pool: Pool = {
  identities: [
    { email: 'a@x', keys: keys('a', 20), roles: { '1': 'owner', '2': 'viewer' } },
    { email: 'b@x', keys: keys('b', 20), roles: { '1': 'member', '2': 'admin', '3': 'owner' } },
    { email: 'c@x', keys: keys('c', 20), roles: { '2': 'owner', '3': 'viewer' } },
  ],
  workspaces: [
    { id: '1', projects: ['10'], tasks: ['100', '101'] },
    { id: '2', projects: ['20'], tasks: ['200'] },
    { id: '3', projects: ['30'], tasks: ['300'] },
  ],
  summary_project: { id: '10', workspace_id: '1', tasks: 2000 },
  search_terms: ['login'],
}

const target = (key: TargetKey) => TARGETS.find((t) => t.key === key) as Target

function seeded(seed = 1) {
  let s = seed

  return () => {
    s = (s * 16807) % 2147483647

    return s / 2147483647
  }
}

test('every class builds authenticated requests whose client ip is fixed per key', () => {
  const ipByKey = new Map<string, string>()
  for (const plan of planLoad(pool)) {
    const next = classSource(plan, pool, seeded())
    for (let i = 0; i < 200; i += 1) {
      const r = next(i)
      const key = (r.headers.authorization ?? '').replace('Bearer ', '')
      const ip = r.headers['x-forwarded-for'] ?? ''
      assert.match(key, /^twl_/)
      assert.match(ip, /^10\.\d+\.\d+\.\d+$/)
      assert.match(r.path, /^\/v1\//)
      assert.equal(ipByKey.get(key) ?? ip, ip)
      ipByKey.set(key, ip)
    }
  }
  assert.equal(new Set(ipByKey.values()).size, ipByKey.size)
})

test('per-key capacity is the role limits capped by the ip bucket and, for get_single, the key-general bucket', () => {
  const perKey = (key: TargetKey, k: string) => slotsFor(pool, target(key)).filter((s) => s.key === k).reduce((n, s) => n + s.per_minute, 0)

  assert.equal(perKey('list', 'twl_a0'), 600 + 60)
  assert.equal(perKey('list', 'twl_b0'), RATE_LIMITS.ip_authenticated)
  assert.equal(perKey('get_single', 'twl_b0'), RATE_LIMITS.key_general * 3)
  assert.equal(perKey('write', 'twl_a0'), 600)
  assert.equal(perKey('summary', 'twl_c0'), 0)
})

test('planned rate is the class rate, bounded by half the pool capacity', () => {
  const list = planClass(pool, target('list'))
  assert.equal(list.capacity_rps, (20 * (660 + 1200 + 660)) / 60)
  assert.equal(list.planned_rps, Math.min(target('list').rps, Math.floor(list.capacity_rps / HEADROOM)))

  const summary = planClass(pool, target('summary'))
  assert.equal(summary.capacity_rps, (20 * (600 + 300)) / 60)
  assert.equal(summary.planned_rps, target('summary').rps)

  const small = { ...pool, identities: [{ email: 'm@x', keys: keys('m', 2), roles: { '1': 'member' } }] }
  assert.equal(planClass(small, target('summary')).planned_rps, Math.floor((2 * 300) / 60 / HEADROOM))

  for (const plan of planLoad(pool)) {
    assert.ok(plan.planned_rps > 0 && plan.planned_rps <= plan.target.rps)
    assert.ok(plan.planned_rps * HEADROOM <= plan.capacity_rps)
  }
  const tiny = { ...pool, identities: [{ email: 'v@x', keys: ['twl_v'], roles: { '1': 'viewer' } }] }
  assert.throws(() => planClass(tiny, target('summary')), /cannot carry summary/)
})

test('warm-up rate keeps the summed bucket utilisation of the mixed load at or below 1/headroom', () => {
  const plans = planLoad(pool)
  const rate = warmupRps(plans)
  const total = plans.reduce((n, p) => n + p.planned_rps, 0)
  const utilisation = plans.reduce((n, p) => n + ((rate / total) * p.planned_rps) / p.capacity_rps, 0)

  assert.ok(rate > 0 && rate <= total)
  assert.ok(utilisation <= 1 / HEADROOM + 1e-9)
})

test('smooth round robin serves each slot in proportion to its weight, interleaved', () => {
  const next = roundRobin([600, 300, 60])
  const order = Array.from({ length: 96 }, () => next())
  const counts = [0, 1, 2].map((i) => order.filter((x) => x === i).length)

  assert.deepEqual(counts, [60, 30, 6])
  assert.notDeepEqual(order.slice(0, 3), [0, 0, 0])
  assert.throws(() => roundRobin([]))
})

test('a class spreads requests over (key, workspace) buckets in proportion to their limits', () => {
  const plan = planClass(pool, target('list'))
  const next = classSource(plan, pool, seeded(5))
  const rounds = 4
  const totalWeight = plan.slots.reduce((n, s) => n + s.per_minute, 0)
  const counts = new Map<string, number>()
  const n = Math.round(rounds * totalWeight)
  for (let i = 0; i < n; i += 1) {
    const r = next(i)
    const ws = r.path.match(/\/v1\/(?:workspaces\/(\d+)|projects\/(\d)0|tasks\/(\d)0\d)/)?.slice(1).find(Boolean)
    const id = `${r.headers.authorization}|${ws}`
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  for (const s of plan.slots) {
    const got = counts.get(`Bearer ${s.key}|${s.workspace.id}`) ?? 0
    assert.ok(Math.abs(got - rounds * s.per_minute) <= 1, `${s.key}/${s.workspace.id}: ${got} vs ${rounds * s.per_minute}`)
  }
})

test('writes use writer roles only and summary stays on its workspace', () => {
  const writes = planClass(pool, target('write'))
  assert.ok(writes.slots.every((s) => s.role !== 'viewer'))
  const next = classSource(writes, pool, seeded(7))
  for (let i = 0; i < 100; i += 1) {
    const r = next(i)
    assert.notEqual(r.method, 'GET')
    assert.ok(r.body && JSON.parse(r.body))
  }
  const summary = planClass(pool, target('summary'))
  assert.ok(summary.slots.every((s) => s.workspace.id === '1'))
  assert.equal(classSource(summary, pool, seeded())(0).path, '/v1/projects/10/summary')
})

test('list queries ask for 50 items and never repeat a query parameter', () => {
  const rng = seeded(3)
  for (let i = 0; i < 2000; i += 1) {
    const names = filterQuery(rng)
      .split('&')
      .map((p) => p.split('=')[0])
    assert.equal(new Set(names).size, names.length)
    assert.ok(names.includes('limit'))
  }
  const next = classSource(planClass(pool, target('list')), pool, seeded(4))
  for (let i = 0; i < 500; i += 1) {
    const query = next(i).path.split('?')[1] ?? ''
    const names = [...new URLSearchParams(query).keys()]
    assert.equal(new Set(names).size, names.length)
    assert.match(query, /limit=50/)
  }
})

test('the mixed warm-up source cycles every class', () => {
  const next = mixedSource(planLoad(pool), pool, seeded(9))
  const paths = Array.from({ length: 400 }, (_, i) => next(i))

  assert.ok(paths.some((r) => r.path.endsWith('/summary')))
  assert.ok(paths.some((r) => r.path.includes('/search?')))
  assert.ok(paths.some((r) => r.method !== 'GET'))
})

test('summarize carries the planned rate, counts statuses and flags misses and invalid runs', () => {
  const latencies = Array.from({ length: 990 }, (_, i) => (i < 980 ? 4 : 60))
  const base: LoadResult = { scheduled: 1000, elapsed_s: 2, latencies_ms: latencies, status: { '200': 600, '201': 390, '429': 10 }, errors: 0, timeouts: 0, max_lag_ms: 0.4, loop_delay_max_ms: 12.34, loop_delay_p99_ms: 5.06 }
  const s = summarize(base, target('get_single'), 500)

  assert.equal(s.planned_rps, 500)
  assert.equal(s.loop_delay_max_ms, 12.3)
  assert.equal(s.loop_delay_p99_ms, 5.1)
  assert.equal(s.rps, 500)
  assert.equal(s.ok_2xx, 990)
  assert.equal(s.p50_ms, 4)
  assert.equal(s.p99_ms, 60)
  assert.equal(s.met, false)
  assert.equal(s.rate_limited, 10)
  assert.equal(s.client_errors, 0)
  assert.equal(s.valid, true)
  const bad = summarize({ ...base, status: { '200': 980, '400': 5, '503': 15 } }, target('get_single'), 500)
  assert.equal(bad.client_errors, 5)
  assert.equal(bad.server_errors, 15)
  assert.equal(bad.valid, false)
  assert.equal(summarize({ ...base, timeouts: 11 }, target('get_single'), 500).valid, false)
})

test('summarize reports p95, max and the error rate over every attempt', () => {
  const latencies = Array.from({ length: 100 }, (_, i) => i + 1)
  const base: LoadResult = { scheduled: 110, elapsed_s: 1, latencies_ms: latencies, status: { '200': 100, '429': 4, '500': 2 }, errors: 3, timeouts: 1, max_lag_ms: 0, loop_delay_max_ms: 0, loop_delay_p99_ms: 0 }
  const s = summarize(base, target('list'), 100)

  assert.equal(s.p50_ms, 50)
  assert.equal(s.p95_ms, 95)
  assert.equal(s.p99_ms, 99)
  assert.equal(s.max_ms, 100)
  assert.equal(s.error_rate, Math.round((10 / 110) * 1e6) / 1e6)
  const empty = summarize({ ...base, latencies_ms: [], status: {}, errors: 0, timeouts: 0 }, target('list'), 100)
  assert.equal(empty.max_ms, 0)
  assert.equal(empty.error_rate, 0)
})

test('combineReps takes medians of percentiles, the worst max and the pooled error rate', () => {
  const rep = (p99: number, max: number, ok: number, failed: number) =>
    summarize(
      { scheduled: 0, elapsed_s: 1, latencies_ms: [...Array.from({ length: 98 }, () => 1), p99, max], status: { '200': ok, '500': failed }, errors: 0, timeouts: 0, max_lag_ms: 0, loop_delay_max_ms: 0, loop_delay_p99_ms: 0 },
      target('get_single'),
      500,
    )
  const reps = [rep(30, 40, 100, 0), rep(70, 90, 100, 0), rep(45, 300, 50, 50)]
  const c = combineReps(reps, target('get_single').p99_ms)

  assert.equal(c.p99_ms, 45)
  assert.equal(c.max_ms, 300)
  assert.equal(c.error_rate, Math.round((50 / 300) * 1e6) / 1e6)
  assert.equal(c.met, true)
  assert.equal(c.valid, false)
  assert.equal(c.requests, 100)
  assert.throws(() => combineReps([], 50))
})

test('searchTerms derives short substrings from titles', () => {
  assert.deepEqual(searchTerms(['Login redirect loop', 'Fix it']), ['login', 'redire', 'loop', 'fix'])
  assert.deepEqual(searchTerms([]), ['task', 'fix', 'the'])
})

test('treeRssMiB sums a process and its descendants', () => {
  const table = [
    { pid: 1, ppid: 0, rssKiB: 1024 },
    { pid: 2, ppid: 1, rssKiB: 2048 },
    { pid: 3, ppid: 2, rssKiB: 1024 },
    { pid: 4, ppid: 0, rssKiB: 9999 },
  ]

  assert.equal(treeRssMiB(1, table), 4)
})
