import { existsSync, readFileSync } from 'node:fs'
import type { Liveness, ProcessName } from './candidate.ts'

export interface Exit {
  at: string
  during: string
}

export type Exits = Partial<Record<ProcessName, Exit>>

const NAMES: ProcessName[] = ['api', 'worker']

export function liveness(now = () => new Date().toISOString()) {
  let phase = 'startup'
  const exits: Exits = {}

  return {
    exits,
    enter: (next: string) => {
      phase = next
    },
    observe: (alive: Liveness) => {
      for (const name of NAMES) if (!alive[name] && !exits[name]) exits[name] = { at: now(), during: phase }
    },
  }
}

export function tailLines(text: string, n: number): string[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-n)
}

function logTail(file: string, n = 20): string[] {
  return existsSync(file) ? tailLines(readFileSync(file, 'utf8'), n) : []
}

export function candidateReport(exits: Exits, logs: Record<ProcessName, string>) {
  return Object.fromEntries(
    NAMES.flatMap((name) => {
      const exit = exits[name]

      return [
        [`${name}_alive`, !exit],
        [`${name}_exited_at`, exit?.at ?? null],
        [`${name}_exited_during`, exit?.during ?? null],
        [`${name}_log_tail`, exit ? logTail(logs[name]) : null],
      ]
    }),
  )
}

export function invalidReason(exits: Exits, invalidClasses: string[]): string | null {
  const reasons = [
    ...NAMES.flatMap((name) => {
      const exit = exits[name]

      return exit ? [`${name} exited during ${exit.during} at ${exit.at}`] : []
    }),
    ...(invalidClasses.length ? [`invalid classes: ${invalidClasses.join(', ')}`] : []),
  ]

  return reasons.length ? reasons.join('; ') : null
}
