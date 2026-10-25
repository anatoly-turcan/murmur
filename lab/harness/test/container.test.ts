import assert from 'node:assert/strict'
import { test } from 'node:test'
import { containerDbUrl, cpuUsage, dockerRunArgs, memoryBytes, parseCgroupBytes, parseCpuStat, parseSample } from '../lib/container.ts'

test('every README database URL form maps to the same file in the mounted /data directory', () => {
  assert.deepEqual(containerDbUrl('sqlite:./perf.db'), { file: 'perf.db', url: 'sqlite:///data/perf.db' })
  assert.deepEqual(containerDbUrl('sqlite:perf.db'), { file: 'perf.db', url: 'sqlite:///data/perf.db' })
  assert.deepEqual(containerDbUrl('sqlite:///runs/x/perf.db'), { file: 'perf.db', url: 'sqlite:///data/perf.db' })
  assert.deepEqual(containerDbUrl('file:./perf.db'), { file: 'perf.db', url: 'file:/data/perf.db' })
  assert.deepEqual(containerDbUrl('file:///runs/x/perf.db?mode=rwc'), { file: 'perf.db', url: 'file:///data/perf.db?mode=rwc' })
  assert.deepEqual(containerDbUrl('/runs/x/perf.db'), { file: 'perf.db', url: '/data/perf.db' })
  assert.deepEqual(containerDbUrl('./perf.db'), { file: 'perf.db', url: '/data/perf.db' })
  assert.throws(() => containerDbUrl('sqlite::memory:'), /does not name a SQLite file/)
  assert.throws(() => containerDbUrl('postgres://x/y'), /does not name a SQLite file/)
  assert.throws(() => containerDbUrl(''), /does not name a SQLite file/)
})

test('memory sizes use docker binary units', () => {
  assert.equal(memoryBytes('1g'), 1024 ** 3)
  assert.equal(memoryBytes('512M'), 512 * 1024 ** 2)
  assert.equal(memoryBytes('1073741824'), 1024 ** 3)
  assert.throws(() => memoryBytes('1 gig'), /--memory/)
})

test('cpu.stat parses usage, user and system microseconds', () => {
  const text = 'usage_usec 2500000\nuser_usec 2000000\nsystem_usec 500000\nnr_periods 10\nnr_throttled 2\nthrottled_usec 1000\n'
  assert.deepEqual(parseCpuStat(text), { usage_usec: 2_500_000, user_usec: 2_000_000, system_usec: 500_000 })
  assert.throws(() => parseCpuStat('nr_periods 1\n'), /usage_usec/)
})

test('cpu usage is the usage delta over elapsed time times the cpu limit', () => {
  const before = { at_ms: 1000, stat: { usage_usec: 1_000_000, user_usec: 800_000, system_usec: 200_000 } }
  const after = { at_ms: 11_000, stat: { usage_usec: 6_000_000, user_usec: 4_800_000, system_usec: 1_200_000 } }

  assert.deepEqual(cpuUsage(before, after, 2), { cpu_s: 5, user_s: 4, system_s: 1, elapsed_s: 10, utilisation: 0.25 })
})

test('cgroup byte files parse to numbers or null', () => {
  assert.equal(parseCgroupBytes('104857600\n'), 104_857_600)
  assert.equal(parseCgroupBytes(''), null)
  assert.equal(parseCgroupBytes('max\n'), null)
})

test('a container sample yields memory, the api and worker tree RSS and whether each is alive', () => {
  const out = ['209715200', 'anon 104857600', '1 0 600', '7 1 1024', '9 7 2048', '8 1 512', '12 8 512', '30 0 99'].join('\n')

  assert.deepEqual(parseSample(out, { api: 7, worker: 8 }), {
    values: { api: 3, worker: 1, memory_current_mib: 200, memory_anon_mib: 100 },
    alive: { api: true, worker: true },
  })
  assert.deepEqual(parseSample(['1 0 600', '7 1 1024'].join('\n'), { api: 7, worker: 8 }), { values: { api: 1, worker: 0 }, alive: { api: true, worker: false } })
})

test('docker run args pin the limits, host network, mounts and the translated env', () => {
  const layout = { repo: '/r/perf-checkout', root: '/r/perf-container', db: '/r/perf-db', home: '/r/perf-container/home' }
  const spec = { image: 'node:26-bookworm-slim', cpus: 2, memoryBytes: 1024 ** 3, network: 'host' as const }
  const env = { TASKWELL_DATABASE_URL: 'sqlite:///data/perf.db', TASKWELL_PORT: '8086' }
  const args = dockerRunArgs(spec, layout, env, 'serve', 'perf-x')
  const after = (flag: string) => args[args.indexOf(flag) + 1]

  assert.equal(after('--network'), 'host')
  assert.equal(after('--cpus'), '2')
  assert.equal(after('--memory'), String(1024 ** 3))
  assert.equal(after('--memory-swap'), String(1024 ** 3))
  assert.equal(after('--workdir'), '/app')
  assert.ok(args.includes('/r/perf-checkout:/app'))
  assert.ok(args.includes('/r/perf-db:/data'))
  assert.ok(args.includes('TASKWELL_DATABASE_URL=sqlite:///data/perf.db'))
  assert.ok(args.includes('--detach'))
  assert.deepEqual(args.slice(-4), ['node:26-bookworm-slim', 'sh', '/harness/entry.sh', 'serve'])

  const published = dockerRunArgs({ ...spec, network: 'publish' }, layout, env, 'serve', 'perf-x')
  assert.ok(!published.includes('--network'))
  assert.equal(published[published.indexOf('--publish') + 1], '127.0.0.1:8086:8086')
  const setup = dockerRunArgs({ ...spec, network: 'publish' }, layout, env, 'setup', '')
  assert.equal(setup[setup.indexOf('--network') + 1], 'host')
  assert.ok(!setup.includes('--detach'))
})
