import { parseArgs } from 'node:util'

export type FlagSpec = Record<string, 'string' | 'boolean'>
export type FlagValues = Record<string, string | boolean | undefined>

export function readFlags(argv: string[], spec: FlagSpec): FlagValues {
  const options = Object.fromEntries(Object.entries(spec).map(([name, type]) => [name, { type }]))
  const { values } = parseArgs({ args: argv, options, strict: true, allowPositionals: false })

  return values as FlagValues
}

export function required(values: FlagValues, name: string): string {
  const value = values[name]
  if (typeof value !== 'string' || value === '') throw new Error(`--${name} is required`)

  return value
}

export function optional(values: FlagValues, name: string): string | undefined {
  const value = values[name]

  return typeof value === 'string' && value !== '' ? value : undefined
}

export function isoTimestamp(value: string, name: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`--${name} must be an ISO-8601 timestamp, got "${value}"`)

  return date.toISOString()
}

export function positiveInt(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer, got "${value}"`)

  return parsed
}

export async function runMain(usage: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(`usage: ${usage}`)
    process.exitCode = 1
  }
}
