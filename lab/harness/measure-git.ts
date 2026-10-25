import { readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { optional, readFlags, required, runMain } from './lib/cli.ts'
import { git, gitRaw, lines } from './lib/git.ts'
import { concurrency, type Concurrency } from './lib/intervals.ts'
import { writeJson } from './lib/io.ts'

const USAGE = 'node measure-git.ts --repo <dir> [--range <rev or a..b>] [--main main] [--out <file>]'
const MARKER = '^(<<<<<<<|>>>>>>>)( |$)'

export interface MergeInfo {
  sha: string
  merged_at: number
  branch_commits: number
  start_first_commit: number
  start_fork: number
  end: number
  conflicted: boolean
  conflicted_files: string[]
  resolution_lines: number
}

export interface GitMetrics {
  range: string
  head: string
  commits: number
  first_parent_commits: number
  merges: number
  octopus_merges: number
  branches_local: number
  unmerged_branches: string[]
  conflicted_merges: number
  conflicted_files: number
  conflict_resolution_lines: number
  amended_clean_merges: number
  marker_commits: number
  rerere_entries: number
  parallel: { lower: Concurrency; upper: Concurrency }
  merges_detail: MergeInfo[]
}

function count(repo: string, args: string[]): number {
  return Number(git(repo, ['rev-list', '--count', ...args]).trim())
}

function numstatTotal(text: string): number {
  return lines(text).reduce((sum, line) => {
    const [added = '0', deleted = '0'] = line.split('\t')

    return sum + (Number(added) || 0) + (Number(deleted) || 0)
  }, 0)
}

export function remerge(repo: string, p1: string, p2: string, merge: string) {
  const result = gitRaw(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', p1, p2])
  if (result.code !== 0 && result.code !== 1) throw new Error(`git merge-tree failed: ${result.stderr.trim()}`)
  const [tree = '', ...rest] = result.stdout.split('\n')
  const blank = rest.indexOf('')
  const files = [...new Set(rest.slice(0, blank < 0 ? undefined : blank).filter(Boolean))]
  const diff = numstatTotal(git(repo, ['diff', '--numstat', tree.trim(), `${merge}^{tree}`]))

  return { conflicted: result.code === 1, files, resolution_lines: diff }
}

function branchTimes(repo: string, p1: string, p2: string, mergedAt: number) {
  const rows = lines(git(repo, ['log', '--format=%at %ct', p2, `^${p1}`])).map((l) => l.split(' ').map(Number))
  if (rows.length === 0) return { commits: 0, first: mergedAt, end: mergedAt, fork: mergedAt }
  const base = git(repo, ['merge-base', p1, p2]).trim()
  const forkTime = Number(git(repo, ['show', '-s', '--format=%ct', base]).trim())

  return {
    commits: rows.length,
    first: Math.min(...rows.map(([a = 0]) => a)),
    end: Math.max(...rows.map(([, c = 0]) => c)),
    fork: forkTime,
  }
}

function mergeInfo(repo: string, row: string): MergeInfo | undefined {
  const [sha = '', at = '0', ...parents] = row.split(' ')
  if (parents.length !== 2) return undefined
  const [p1 = '', p2 = ''] = parents
  const times = branchTimes(repo, p1, p2, Number(at))
  const re = remerge(repo, p1, p2, sha)

  return {
    sha,
    merged_at: Number(at),
    branch_commits: times.commits,
    start_first_commit: Math.min(times.first, times.end),
    start_fork: Math.min(times.fork, times.end),
    end: times.end,
    conflicted: re.conflicted,
    conflicted_files: re.files,
    resolution_lines: re.resolution_lines,
  }
}

function rerereEntries(repo: string): number {
  const common = git(repo, ['rev-parse', '--git-common-dir']).trim()
  const dir = join(isAbsolute(common) ? common : join(repo, common), 'rr-cache')
  try {
    return readdirSync(dir).length
  } catch {
    return 0
  }
}

export function measureGit(repo: string, range = 'main', main = 'main'): GitMetrics {
  const mergeRows = lines(git(repo, ['log', '--merges', '--format=%H %ct %P', range]))
  const merges = mergeRows.map((row) => mergeInfo(repo, row)).filter((m) => m !== undefined)
  const conflicted = merges.filter((m) => m.conflicted)
  const branches = lines(git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
  const unmerged = lines(git(repo, ['branch', '--format=%(refname:short)', '--no-merged', main]))

  return {
    range,
    head: git(repo, ['rev-parse', main]).trim(),
    commits: count(repo, [range]),
    first_parent_commits: count(repo, ['--first-parent', range]),
    merges: mergeRows.length,
    octopus_merges: mergeRows.length - merges.length,
    branches_local: branches.length,
    unmerged_branches: unmerged,
    conflicted_merges: conflicted.length,
    conflicted_files: conflicted.reduce((sum, m) => sum + m.conflicted_files.length, 0),
    conflict_resolution_lines: conflicted.reduce((sum, m) => sum + m.resolution_lines, 0),
    amended_clean_merges: merges.filter((m) => !m.conflicted && m.resolution_lines > 0).length,
    marker_commits: lines(git(repo, ['log', '--format=%H', '-G', MARKER, range])).length,
    rerere_entries: rerereEntries(repo),
    parallel: {
      lower: concurrency(merges.map((m) => ({ start: m.start_first_commit, end: m.end }))),
      upper: concurrency(merges.map((m) => ({ start: m.start_fork, end: m.end }))),
    },
    merges_detail: merges,
  }
}

if (import.meta.main) {
  await runMain(USAGE, () => {
    const f = readFlags(process.argv.slice(2), { repo: 'string', range: 'string', main: 'string', out: 'string' })
    const repo = required(f, 'repo')
    const main = optional(f, 'main') ?? 'main'
    const metrics = measureGit(repo, optional(f, 'range') ?? main, main)
    writeJson(optional(f, 'out') ?? join(repo, '..', 'git.json'), metrics)
    const { merges_detail, ...summary } = metrics
    console.log(JSON.stringify({ ...summary, merges_detail: `${merges_detail.length} merges` }, null, 2))
  })
}
