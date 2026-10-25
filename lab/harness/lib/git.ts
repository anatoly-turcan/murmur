import { spawnSync } from 'node:child_process'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export function gitRaw(repo: string, args: string[], env: Record<string, string> = {}): GitResult {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env },
  })

  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

export function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  const result = gitRaw(repo, args, env)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`)

  return result.stdout
}

export function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '')
}
