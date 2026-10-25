import { basename, join } from 'node:path'
import { optional, readFlags, required, runMain } from './lib/cli.ts'
import { countDeps, countLockPackages, type DepCounts, type Manifest } from './lib/deps.ts'
import { git, lines } from './lib/git.ts'
import { writeJson } from './lib/io.ts'
import { classify, countLoc, countTestCases, isIgnoredDir, type FileKind } from './lib/loc.ts'
import { ratio } from './lib/stats.ts'

const USAGE = 'node measure-code.ts --repo <dir> [--ref main] [--out <file>]'
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']

export interface FileTally {
  files: number
  loc: number
}

export interface CodeMetrics {
  ref: string
  sha: string
  src: FileTally
  test: FileTally & { cases: number }
  migration: FileTally
  by_ext: Record<string, FileTally>
  deps: DepCounts & { lock_packages: number; lockfiles: string[] }
  units: { murmur_pieces: number; murmur_contract_files: number; nest_modules: number }
  coverage_proxy: { test_loc_per_src_loc: number; cases_per_100_src_loc: number }
}

interface RepoFile {
  path: string
  text: string
}

function wanted(path: string): boolean {
  if (isIgnoredDir(path)) return false

  return classify(path) !== 'ignored' || basename(path) === 'package.json' || LOCKFILES.includes(basename(path))
}

function trackedFiles(repo: string, ref: string): RepoFile[] {
  const paths = lines(git(repo, ['ls-tree', '-r', '--name-only', ref])).filter(wanted)

  return paths.map((path) => ({ path, text: git(repo, ['show', `${ref}:${path}`]) }))
}

function tallyKind(files: RepoFile[], kind: FileKind): FileTally {
  const chosen = files.filter((f) => classify(f.path) === kind)

  return { files: chosen.length, loc: chosen.reduce((sum, f) => sum + countLoc(f.text, f.path), 0) }
}

function byExtension(files: RepoFile[]): Record<string, FileTally> {
  const src = files.filter((f) => classify(f.path) === 'src')
  const groups = Map.groupBy(src, (f) => f.path.slice(f.path.lastIndexOf('.')))

  return Object.fromEntries([...groups].map(([ext, fs]) => [ext, { files: fs.length, loc: fs.reduce((s, f) => s + countLoc(f.text, f.path), 0) }]))
}

function dependencies(files: RepoFile[]): CodeMetrics['deps'] {
  const manifests: Manifest[] = files
    .filter((f) => basename(f.path) === 'package.json')
    .map((f) => ({ path: f.path, json: JSON.parse(f.text) as Manifest['json'] }))
  const locks = files.filter((f) => LOCKFILES.includes(basename(f.path)))

  return {
    ...countDeps(manifests),
    lock_packages: locks.reduce((sum, f) => sum + countLockPackages(basename(f.path), f.text), 0),
    lockfiles: locks.map((f) => f.path),
  }
}

function units(files: RepoFile[]): CodeMetrics['units'] {
  const live = files.filter((f) => classify(f.path) === 'src')

  return {
    murmur_pieces: live.filter((f) => /(?:^|\/)pieces\/.*\/piece\.ts$/.test(f.path)).length,
    murmur_contract_files: live.filter((f) => /(?:^|\/)contracts(?:\/[^/]+|)\.ts$/.test(f.path)).length,
    nest_modules: live.filter((f) => /\.module\.ts$/.test(f.path)).length,
  }
}

export function measureCode(repo: string, ref = 'main'): CodeMetrics {
  const files = trackedFiles(repo, ref)
  const src = tallyKind(files, 'src')
  const test = tallyKind(files, 'test')
  const cases = files.filter((f) => classify(f.path) === 'test').reduce((sum, f) => sum + countTestCases(f.text), 0)

  return {
    ref,
    sha: git(repo, ['rev-parse', ref]).trim(),
    src,
    test: { ...test, cases },
    migration: tallyKind(files, 'migration'),
    by_ext: byExtension(files),
    deps: dependencies(files),
    units: units(files),
    coverage_proxy: { test_loc_per_src_loc: ratio(test.loc, src.loc), cases_per_100_src_loc: ratio(cases * 100, src.loc) },
  }
}

if (import.meta.main) {
  await runMain(USAGE, () => {
    const f = readFlags(process.argv.slice(2), { repo: 'string', ref: 'string', out: 'string' })
    const repo = required(f, 'repo')
    const metrics = measureCode(repo, optional(f, 'ref') ?? 'main')
    writeJson(optional(f, 'out') ?? join(repo, '..', 'code.json'), metrics)
    console.log(JSON.stringify(metrics, null, 2))
  })
}
