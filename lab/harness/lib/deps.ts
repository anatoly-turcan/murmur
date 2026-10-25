export interface Manifest {
  path: string
  json: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
}

export interface DepCounts {
  manifests: number
  direct_prod: number
  direct_dev: number
  names_prod: string[]
  names_dev: string[]
  db_hints: string[]
}

const INTERNAL = /^(?:workspace:|link:|file:|portal:)/
const DB_DRIVERS = [
  'pg',
  'postgres',
  'pg-promise',
  '@neondatabase/serverless',
  'better-sqlite3',
  'sqlite3',
  'sqlite',
  '@libsql/client',
  'mysql2',
  '@prisma/client',
  'prisma',
  'typeorm',
  '@mikro-orm/core',
  'drizzle-orm',
  'kysely',
  'knex',
  'sequelize',
]

function externalNames(deps: Record<string, string> | undefined): string[] {
  return Object.entries(deps ?? {})
    .filter(([, spec]) => !INTERNAL.test(spec))
    .map(([name]) => name)
}

export function countDeps(manifests: Manifest[]): DepCounts {
  const prod = new Set(manifests.flatMap((m) => [...externalNames(m.json.dependencies), ...externalNames(m.json.optionalDependencies)]))
  const dev = new Set(manifests.flatMap((m) => externalNames(m.json.devDependencies)).filter((n) => !prod.has(n)))
  const all = new Set([...prod, ...dev])

  return {
    manifests: manifests.length,
    direct_prod: prod.size,
    direct_dev: dev.size,
    names_prod: [...prod].sort(),
    names_dev: [...dev].sort(),
    db_hints: DB_DRIVERS.filter((d) => all.has(d)),
  }
}

function pnpmDocumentPackages(doc: string): number {
  const lines = doc.split('\n')
  const start = lines.findIndex((l) => l === 'packages:')
  if (start < 0) return 0
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l))
  const section = lines.slice(start + 1, end < 0 ? undefined : end)

  return section.filter((l) => /^ {2}\S.*:\s*$/.test(l)).length
}

export function countLockPackages(fileName: string, text: string): number {
  if (fileName === 'pnpm-lock.yaml') {
    const docs = text.split(/^---\s*$/m).filter((d) => d.includes('importers:') && !d.includes('packageManagerDependencies'))

    return docs.reduce((sum, d) => sum + pnpmDocumentPackages(d), 0)
  }
  if (fileName === 'package-lock.json') {
    const packages = (JSON.parse(text) as { packages?: Record<string, unknown> }).packages ?? {}

    return Object.keys(packages).filter((k) => k !== '').length
  }
  if (fileName === 'yarn.lock') return text.split('\n').filter((l) => /^"?[^\s#].*:$/.test(l)).length

  return 0
}
