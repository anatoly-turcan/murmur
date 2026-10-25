import { join, resolve } from 'node:path'

export const FRAMEWORKS = ['murmur', 'nestjs'] as const
export const MODELS = ['opus', 'sonnet'] as const
export const PHASES = ['phase1', 'phase2'] as const
export const ORCHESTRATOR_MODEL = 'fable'
export const CHANGE_REQUESTS = ['CR-1', 'CR-2', 'CR-3'] as const

export type Framework = (typeof FRAMEWORKS)[number]
export type Model = (typeof MODELS)[number]
export type Phase = (typeof PHASES)[number]

export const LAB_ROOT = resolve(import.meta.dirname, '../..')
export const DEFAULT_RUNS_ROOT = resolve(LAB_ROOT, '../../murmur-runs')
export const RUNS_ROOT = process.env.LAB_RUNS_ROOT || DEFAULT_RUNS_ROOT
export const DEFAULT_CANDIDATE_PORT = '8085'
export const NPM_REGISTRY = process.env.LAB_NPM_REGISTRY || 'http://127.0.0.1:4873'
export const CANDIDATE_PORT = process.env.LAB_CANDIDATE_PORT || DEFAULT_CANDIDATE_PORT

export function oneOf<T extends string>(allowed: readonly T[], value: string, name: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`--${name} must be one of ${allowed.join(', ')}, got "${value}"`)
  }

  return value as T
}

export function runId(framework: Framework, model: Model, n: number): string {
  return `${framework}-${model}-${n}`
}

export function parseRunId(id: string): { framework: Framework; model: Model; n: number } {
  const match = /^(murmur|nestjs)-(opus|sonnet)-(\d+)$/.exec(id)
  if (!match) throw new Error(`not a run id: "${id}"`)

  return { framework: match[1] as Framework, model: match[2] as Model, n: Number(match[3]) }
}

export function runDir(phase: Phase, id: string, runsRoot = RUNS_ROOT): string {
  return join(runsRoot, phase, id)
}

export function crKey(cr: string): string {
  return cr.toLowerCase().replace('-', '')
}
