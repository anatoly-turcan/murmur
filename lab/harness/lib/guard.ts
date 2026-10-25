import { readdirSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { CHANGE_REQUESTS, PHASES, crKey } from './arms.ts'
import { readJsonIfExists } from './io.ts'
import type { RunMeta } from './schema.ts'

export function portInUse(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const done = (busy: boolean) => {
      socket.destroy()
      resolve(busy)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

export function isActive(meta: RunMeta): boolean {
  if (meta.stop) return false
  const t = meta.timestamps
  if (meta.phase === 'phase1') return Boolean(t.kickoff) && !t.done

  return CHANGE_REQUESTS.some((cr) => Boolean(t[`${crKey(cr)}_start`]) && !t[`${crKey(cr)}_done`])
}

export function activeRuns(runsRoot: string): string[] {
  return PHASES.flatMap((phase) => {
    let names: string[] = []
    try {
      names = readdirSync(join(runsRoot, phase))
    } catch {
      return []
    }

    return names
      .filter((name) => {
        const meta = readJsonIfExists<RunMeta>(join(runsRoot, phase, name, 'run.json'))

        return meta !== undefined && isActive(meta)
      })
      .map((name) => `${phase}/${name}`)
  })
}

export async function assertHostFree(runsRoot: string, port: number, self?: string): Promise<void> {
  const others = activeRuns(runsRoot).filter((id) => id !== self)
  if (others.length) throw new Error(`refusing: run(s) still active (${others.join(', ')}); stamp them done or stopped first`)
  if (await portInUse(port)) throw new Error(`refusing: something is listening on 127.0.0.1:${port} (a previous candidate?); stop it first`)
}
