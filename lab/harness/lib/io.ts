import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function readJsonIfExists<T>(path: string): T | undefined {
  return existsSync(path) ? readJson<T>(path) : undefined
}

export function writeJson(path: string, data: unknown): void {
  writeText(path, `${JSON.stringify(data, null, 2)}\n`)
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}
