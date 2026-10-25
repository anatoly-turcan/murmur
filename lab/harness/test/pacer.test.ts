import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { percentile, runPaced, scheduledAt } from '../lib/pacer.ts'

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; server: Server }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

test('requests are scheduled at a fixed interval of 1/rate', () => {
  assert.equal(scheduledAt(1000, 500, 0), 1000)
  assert.equal(scheduledAt(1000, 500, 1), 1002)
  assert.equal(scheduledAt(1000, 200, 10), 1050)
})

test('percentile uses the nearest rank', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1)
  assert.equal(percentile(xs, 50), 50)
  assert.equal(percentile(xs, 99), 99)
  assert.equal(percentile([], 99), 0)
})

test('runPaced sends at the planned rate, spread smoothly, and counts statuses', async () => {
  const starts: number[] = []
  const bodies: string[] = []
  const { url, server } = await serve((req, res) => {
    starts.push(performance.now())
    let body = ''
    req.on('data', (c: Buffer) => (body += c))
    req.on('end', () => {
      bodies.push(body)
      res.statusCode = req.url === '/limited' ? 429 : 201
      res.end('{}')
    })
  })
  try {
    const result = await runPaced({
      baseUrl: url,
      rate: 200,
      durationS: 1,
      connections: 10,
      timeoutMs: 1000,
      build: (seq) => ({ method: 'POST', path: seq % 10 === 0 ? '/limited' : '/ok', headers: { 'content-type': 'application/json' }, body: `{"n":${seq}}` }),
    })

    assert.equal(result.scheduled, 200)
    assert.deepEqual(result.status, { '201': 180, '429': 20 })
    assert.equal(result.latencies_ms.length, 180)
    assert.ok(Math.abs(200 / result.elapsed_s - 200) / 200 < 0.05, `achieved ${200 / result.elapsed_s}`)
    assert.ok(bodies.includes('{"n":1}'))
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] as number))
    const firstHalf = starts.filter((t) => t - (starts[0] as number) < 500).length
    assert.ok(firstHalf > 80 && firstHalf < 120, `first half-second carried ${firstHalf} of 200`)
    assert.ok(Math.max(...gaps) < 50, `largest gap ${Math.max(...gaps)} ms`)
  } finally {
    await close(server)
  }
})

test('latency counts from the scheduled start when every connection is busy', async () => {
  const { url, server } = await serve((_req, res) => setTimeout(() => res.end('ok'), 40))
  try {
    const result = await runPaced({ baseUrl: url, rate: 100, durationS: 0.3, connections: 1, timeoutMs: 1000, build: () => ({ method: 'GET', path: '/', headers: {} }) })
    const sorted = [...result.latencies_ms].sort((a, b) => a - b)

    assert.equal(result.scheduled, 30)
    assert.ok((sorted.at(-1) as number) > 600, `worst latency ${sorted.at(-1)} ms should include queueing behind the busy connection`)
    assert.ok(result.max_lag_ms > 500)
  } finally {
    await close(server)
  }
})

test('timeouts and connection errors are counted, not thrown', async () => {
  const { url, server } = await serve(() => {})
  try {
    const result = await runPaced({ baseUrl: url, rate: 20, durationS: 0.1, connections: 2, timeoutMs: 100, build: () => ({ method: 'GET', path: '/', headers: {} }) })
    assert.equal(result.timeouts, 2)
  } finally {
    server.closeAllConnections()
    await close(server)
  }
  const refused = await runPaced({ baseUrl: url, rate: 20, durationS: 0.1, connections: 1, timeoutMs: 100, build: () => ({ method: 'GET', path: '/', headers: {} }) })
  assert.equal(refused.errors, 2)
})

test('a harness-side stall shows up as event-loop delay next to the start lag', async () => {
  const { url, server } = await serve((_req, res) => res.end('ok'))
  try {
    const block = (ms: number) => {
      const until = performance.now() + ms
      while (performance.now() < until) {}
    }
    const build = (seq: number) => {
      if (seq === 10) block(200)

      return { method: 'GET', path: '/', headers: {} }
    }
    const stalled = await runPaced({ baseUrl: url, rate: 100, durationS: 0.5, connections: 5, timeoutMs: 1000, build })
    const calm = await runPaced({ baseUrl: url, rate: 100, durationS: 0.5, connections: 5, timeoutMs: 1000, build: () => ({ method: 'GET', path: '/', headers: {} }) })

    assert.ok(stalled.loop_delay_max_ms > 150, `stalled loop delay ${stalled.loop_delay_max_ms} ms`)
    assert.ok(stalled.max_lag_ms > 150)
    assert.ok(calm.loop_delay_max_ms < 100, `calm loop delay ${calm.loop_delay_max_ms} ms`)
  } finally {
    await close(server)
  }
})
