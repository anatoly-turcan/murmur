import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../lib/git.ts'

export function tempDir(prefix = 'harness-'): string {
  return mkdtempSync(join(process.env.HARNESS_TMP ?? tmpdir(), prefix))
}

let tick = 0

export function commit(repo: string, file: string, content: string, message: string, epoch: number): void {
  writeFileSync(join(repo, file), content)
  git(repo, ['add', file])
  const at = `${epoch + tick++} +0000`
  git(repo, ['commit', '-q', '-m', message], {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_DATE: at,
  })
}

export function mergeNoFf(repo: string, branch: string, epoch: number): boolean {
  const env = {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_AUTHOR_DATE: `${epoch} +0000`,
    GIT_COMMITTER_DATE: `${epoch} +0000`,
  }
  try {
    git(repo, ['merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch], env)

    return true
  } catch {
    return false
  }
}
