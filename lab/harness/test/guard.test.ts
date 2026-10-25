import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { activeRuns, assertHostFree, isActive, portInUse } from '../lib/guard.ts'
import { writeJson } from '../lib/io.ts'
import type { RunMeta } from '../lib/schema.ts'
import { tempDir } from './helpers.ts'

const meta = (phase: RunMeta['phase'], timestamps: Record<string, string>, stop: RunMeta['stop'] = null) => ({ phase, timestamps, stop }) as RunMeta

test('a run is active between kickoff and done unless stopped', () => {
  assert.equal(isActive(meta('phase1', { created: 'x' })), false)
  assert.equal(isActive(meta('phase1', { kickoff: 'x' })), true)
  assert.equal(isActive(meta('phase1', { kickoff: 'x', done: 'y' })), false)
  assert.equal(isActive(meta('phase1', { kickoff: 'x' }, { reason: 'token_cap', at: 'y' })), false)
  assert.equal(isActive(meta('phase2', { cr1_start: 'x', cr1_done: 'y', cr2_start: 'z' })), true)
  assert.equal(isActive(meta('phase2', { cr1_start: 'x', cr1_done: 'y' })), false)
})

test('activeRuns and assertHostFree refuse while another run is live', async () => {
  const root = tempDir('runs-')
  mkdirSync(join(root, 'phase1', 'nestjs-opus-1'), { recursive: true })
  writeJson(join(root, 'phase1', 'nestjs-opus-1', 'run.json'), meta('phase1', { kickoff: 'x' }))

  assert.deepEqual(activeRuns(root), ['phase1/nestjs-opus-1'])
  await assert.rejects(assertHostFree(root, 1), /still active/)
  assert.deepEqual(activeRuns(tempDir('empty-')), [])
})

test('portInUse detects a listener and assertHostFree refuses it', async () => {
  const server = createServer().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as { port: number }
  try {
    assert.equal(await portInUse(port), true)
    await assert.rejects(assertHostFree(tempDir('empty-'), port), /listening/)
  } finally {
    server.close()
  }
  assert.equal(await portInUse(1), false)
})
