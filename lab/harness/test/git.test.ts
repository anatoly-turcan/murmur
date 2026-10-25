import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { git } from '../lib/git.ts'
import { measureGit } from '../measure-git.ts'
import { commit, mergeNoFf, tempDir } from './helpers.ts'

const T0 = 1_800_000_000
const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

function repoWithHistory(): string {
  const repo = tempDir('git-')
  git(repo, ['init', '-q', '--initial-branch=main'])
  commit(repo, 'shared.ts', 'export const a = 1\n', 'init', T0)
  git(repo, ['branch', 'issue-001'])
  git(repo, ['branch', 'issue-002'])
  git(repo, ['branch', 'issue-003'])
  git(repo, ['checkout', '-q', 'issue-001'])
  commit(repo, 'one.ts', 'export const one = 1\n', 'one', T0 + 100)
  commit(repo, 'shared.ts', 'export const a = 2\n', 'one shared', T0 + 400)
  git(repo, ['checkout', '-q', 'issue-002'])
  commit(repo, 'two.ts', 'export const two = 2\n', 'two', T0 + 200)
  commit(repo, 'shared.ts', 'export const a = 3\n', 'two shared', T0 + 500)
  git(repo, ['checkout', '-q', 'issue-003'])
  commit(repo, 'three.ts', 'export const three = 3\n', 'three', T0 + 2000)
  git(repo, ['checkout', '-q', 'main'])
  assert.equal(mergeNoFf(repo, 'issue-001', T0 + 600), true)
  assert.equal(mergeNoFf(repo, 'issue-002', T0 + 700), false)
  writeFileSync(join(repo, 'shared.ts'), 'export const a = 23\nexport const b = 0\n')
  git(repo, ['add', 'shared.ts'])
  git(repo, ['commit', '-q', '--no-edit'], { ...ENV, GIT_AUTHOR_DATE: `${T0 + 800} +0000`, GIT_COMMITTER_DATE: `${T0 + 800} +0000` })
  assert.equal(mergeNoFf(repo, 'issue-003', T0 + 2100), true)

  return repo
}

test('measureGit counts merges, conflicts, resolution rework and overlap', () => {
  const repo = repoWithHistory()
  const g = measureGit(repo)

  assert.equal(g.merges, 3)
  assert.equal(g.conflicted_merges, 1)
  assert.deepEqual(g.merges_detail.find((m) => m.conflicted)?.conflicted_files, ['shared.ts'])
  assert.ok(g.conflict_resolution_lines > 0)
  assert.equal(g.amended_clean_merges, 0)
  assert.equal(g.marker_commits, 0)
  assert.equal(g.parallel.lower.max, 2)
  assert.equal(g.parallel.upper.max, 3)
  assert.ok(g.parallel.upper.busy_span_s >= g.parallel.lower.busy_span_s)
})

test('measureGit restricts to a range', () => {
  const repo = repoWithHistory()
  const firstMerge = git(repo, ['log', '--merges', '--reverse', '--format=%H', 'main']).split('\n')[0] as string
  const g = measureGit(repo, `${firstMerge}..main`)

  assert.equal(g.merges, 2)
})

test('committed conflict markers are detected', () => {
  const repo = tempDir('git-')
  git(repo, ['init', '-q', '--initial-branch=main'])
  commit(repo, 'a.ts', 'x\n', 'init', T0)
  commit(repo, 'a.ts', '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> issue-9\n', 'oops', T0 + 10)

  assert.equal(measureGit(repo).marker_commits, 1)
})
