import type { Framework, Model, Phase } from './arms.ts'

export type TestStatus = 'pass' | 'fail' | 'skip' | 'todo'
export type TestKind = 'trap' | 'happy' | 'errors' | 'other'
export type SuiteClassification = 'not_implemented' | 'wrong' | 'untested' | 'untested_but_works' | 'caught_by_own_tests' | null

export interface SuiteTest {
  name: string
  category: string
  kind: TestKind
  status: TestStatus
  trapId?: string
  trapIds?: string[]
  classification?: SuiteClassification
  suite?: string
  file?: string
  durationMs?: number
  message?: string
}

export interface SuiteResults {
  generatedAt?: string
  complete?: boolean
  baseUrl?: string | null
  harnessErrors?: Array<{ file: string; message: string }>
  tests: SuiteTest[]
}

export const TRAP_OUTCOMES = ['not_implemented', 'wrong', 'untested_but_works', 'caught_by_own_tests', 'covered'] as const
export type TrapOutcome = (typeof TRAP_OUTCOMES)[number]
export const FAILED_OUTCOMES: readonly TrapOutcome[] = ['not_implemented', 'wrong', 'untested_but_works', 'caught_by_own_tests']
export const PASSED_OUTCOMES: readonly TrapOutcome[] = ['covered', 'untested_but_works']
export const SUITE_TO_OUTCOME: Record<string, TrapOutcome> = {
  not_implemented: 'not_implemented',
  wrong: 'wrong',
  untested: 'untested_but_works',
  untested_but_works: 'untested_but_works',
  caught_by_own_tests: 'caught_by_own_tests',
}

export interface Adjudication {
  adjudicator?: string
  trap_outcomes?: Record<string, TrapOutcome>
  tests?: SuiteTest[]
  notes?: string
}

export interface TokenCounts {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

export interface TokensFile {
  source?: string
  totals: TokenCounts
  by_role?: Record<string, TokenCounts & { model?: string; turns?: number }>
  by_cr?: Record<string, TokenCounts & { turns?: number }>
  agent_turns?: number
  agents_spawned?: number
  usd?: number
}

export interface Bug {
  id: string
  title: string
  severity: 'critical' | 'major' | 'minor'
  confirmed: boolean
  in_hidden_suite: boolean
  spec_ref?: string
}

export interface BugsFile {
  tester_model: string
  budget_tokens?: number
  bugs: Bug[]
}

export interface ReadabilityFile {
  rater: string
  minutes: number
  probes_minutes: Record<string, number>
  likert: Record<string, number>
  notes?: string
}

export interface RunMeta {
  schema: 1
  id: string
  phase: Phase
  framework: Framework
  model: Model
  n: number
  orchestrator_model: string
  implementer_model: Model
  reviewer_model: Model
  framework_ref: string | null
  source_run: string | null
  base_sha: string | null
  inputs: Record<string, string>
  timestamps: Record<string, string>
  shas: Record<string, string>
  bounces: string[]
  stop: { reason: string; at: string } | null
  meta: Record<string, string>
}
