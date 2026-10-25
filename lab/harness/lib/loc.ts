export type FileKind = 'src' | 'test' | 'migration' | 'ignored'

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|sql|prisma)$/
const IGNORED_DIR = /(?:^|\/)(?:node_modules|dist|build|coverage|\.git|\.worktrees|vendor|generated|\.turbo|\.next)\//
const TEST_DIR = /(?:^|\/)(?:test|tests|__tests__|e2e|spec)\//
const TEST_FILE = /\.(?:test|spec|e2e-spec|e2e)\.[cm]?[jt]sx?$/
const MIGRATION_DIR = /(?:^|\/)migrations?\//
const DECLARATION = /\.d\.[cm]?ts$/

export function isIgnoredDir(path: string): boolean {
  return IGNORED_DIR.test(path)
}

export function classify(path: string): FileKind {
  if (IGNORED_DIR.test(path) || !SOURCE_EXT.test(path) || DECLARATION.test(path)) return 'ignored'
  if (TEST_DIR.test(path) || TEST_FILE.test(path)) return 'test'
  if (MIGRATION_DIR.test(path)) return 'migration'

  return 'src'
}

function isCommentLine(line: string, sql: boolean): boolean {
  if (sql && line.startsWith('--')) return true

  return line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || line.startsWith('*/')
}

export function countLoc(text: string, path = ''): number {
  const sql = path.endsWith('.sql')

  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !isCommentLine(l, sql)).length
}

export function countTestCases(text: string): number {
  const plain = text.match(/(?:^|[^\w.])(?:it|test)(?:\.(?:only|skip|todo|concurrent|each\([^)]*\)))?\s*\(/g)?.length ?? 0
  const subtests = text.match(/\bt\.test\s*\(/g)?.length ?? 0

  return plain + subtests
}
