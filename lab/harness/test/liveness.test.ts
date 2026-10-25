import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { candidateReport, invalidReason, liveness, tailLines } from '../lib/liveness.ts'

test('liveness records the first exit of each process with the phase it happened in', () => {
  let t = 0
  const live = liveness(() => `t${(t += 1)}`)
  live.observe({ api: true, worker: true })
  live.enter('seed')
  live.observe({ api: true, worker: false })
  live.enter('list')
  live.observe({ api: false, worker: false })

  assert.deepEqual(live.exits, { worker: { at: 't1', during: 'seed' }, api: { at: 't2', during: 'list' } })
})

test('the candidate report carries the log tail of a dead process only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'liveness-'))
  const logs = { api: join(dir, 'api.log'), worker: join(dir, 'worker.log') }
  writeFileSync(logs.worker, Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n\n')
  const report = candidateReport({ worker: { at: 'x', during: 'seed' } }, logs)

  assert.equal(report.api_alive, true)
  assert.equal(report.api_log_tail, null)
  assert.equal(report.worker_alive, false)
  assert.equal(report.worker_exited_during, 'seed')
  assert.deepEqual(report.worker_log_tail, Array.from({ length: 20 }, (_, i) => `line ${i + 10}`))
  assert.deepEqual(tailLines('a\n\nb\n', 5), ['a', 'b'])
})

test('invalid reason names dead processes and invalid classes, null when all is well', () => {
  assert.equal(invalidReason({}, []), null)
  assert.equal(invalidReason({ worker: { at: 'x', during: 'seed' } }, ['write']), 'worker exited during seed at x; invalid classes: write')
})
