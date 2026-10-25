import { join } from 'node:path'
import { CHANGE_REQUESTS, crKey } from './lib/arms.ts'
import { isoTimestamp, optional, readFlags, required, runMain } from './lib/cli.ts'
import { readJson, writeJson } from './lib/io.ts'
import type { RunMeta } from './lib/schema.ts'

const USAGE =
  'node stamp.ts --run <dir> (--event <name> --at <iso> [--sha <commit>] [--reason <text>] | --set <key>=<value>)'

const CR_EVENTS = CHANGE_REQUESTS.flatMap((cr) => [`${crKey(cr)}_start`, `${crKey(cr)}_done`, `${crKey(cr)}_accepted`])
export const EVENTS = ['kickoff', 'done', 'accepted', 'bounce', 'stopped', ...CR_EVENTS]

export interface StampInput {
  event?: string
  at?: string
  sha?: string
  reason?: string
  set?: string
}

function applyEvent(meta: RunMeta, input: StampInput): RunMeta {
  const event = input.event as string
  if (!EVENTS.includes(event)) throw new Error(`--event must be one of ${EVENTS.join(', ')}`)
  if (!input.at) throw new Error('--at is required with --event')
  const shas = input.sha ? { ...meta.shas, [event]: input.sha } : meta.shas
  if (event === 'bounce') return { ...meta, bounces: [...meta.bounces, input.at], shas }
  if (event === 'stopped') return { ...meta, stop: { reason: input.reason ?? 'unspecified', at: input.at }, shas }

  return { ...meta, timestamps: { ...meta.timestamps, [event]: input.at }, shas }
}

function applySet(meta: RunMeta, assignment: string): RunMeta {
  const eq = assignment.indexOf('=')
  if (eq < 1) throw new Error('--set expects key=value')

  return { ...meta, meta: { ...meta.meta, [assignment.slice(0, eq)]: assignment.slice(eq + 1) } }
}

export function stamp(meta: RunMeta, input: StampInput): RunMeta {
  if (input.set) return applySet(meta, input.set)
  if (input.event) return applyEvent(meta, input)
  throw new Error('nothing to do: pass --event or --set')
}

if (import.meta.main) {
  await runMain(USAGE, () => {
    const f = readFlags(process.argv.slice(2), { run: 'string', event: 'string', at: 'string', sha: 'string', reason: 'string', set: 'string' })
    const path = join(required(f, 'run'), 'run.json')
    const at = optional(f, 'at')
    const next = stamp(readJson<RunMeta>(path), {
      event: optional(f, 'event'),
      at: at ? isoTimestamp(at, 'at') : undefined,
      sha: optional(f, 'sha'),
      reason: optional(f, 'reason'),
      set: optional(f, 'set'),
    })
    writeJson(path, next)
    console.log(JSON.stringify({ timestamps: next.timestamps, bounces: next.bounces, stop: next.stop, meta: next.meta }))
  })
}
