import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parse } from 'yaml';

import type { Analysis } from './analyze.ts';
import { HEADINGS } from './context-headings.ts';
import type { Level, Section } from './context-sections.ts';
import { fence, joinBlocks } from './markdown.ts';
import { readSource } from './source-checks.ts';
import { createsTable, exampleRowIn, sqlStatements, sqlStringsIn, statementsFor } from './storage-sql.ts';
import { tablesNamedIn } from './storage-tables.ts';
import type { FolderNode } from './types.ts';

interface SqlSource {
  readonly path: string;
  readonly text: string;
}

interface SourceSet {
  readonly label: string;
  readonly sources: readonly SqlSource[];
}

interface ExampleRow {
  readonly path: string;
  readonly sql: string;
}

export interface TableStorage {
  readonly table: string;
  readonly origin: string | null;
  readonly statements: readonly string[];
  readonly example: ExampleRow | null;
}

export interface OwnedStorage {
  readonly tables: readonly TableStorage[];
  readonly looked: readonly string[];
}

const SKIPPED_DIRS = new Set(['node_modules']);

const DEFAULT_MIGRATIONS_DIR = 'migrations';

function lineage(analysis: Analysis, node: FolderNode): FolderNode[] {
  const parent = node.parent === null ? undefined : analysis.repo.folders.get(node.parent);

  return parent === undefined ? [node] : [...lineage(analysis, parent), node];
}

function namedTables(analysis: Analysis, node: FolderNode): string[] {
  const texts = lineage(analysis, node).map((n) =>
    n.contextFile === null ? '' : (readSource(n.contextFile) ?? ''),
  );

  return [...new Set(texts.flatMap(tablesNamedIn))];
}

function interpolated(value: string): string | null {
  if (/\$\{[^}:]+\}/.test(value)) {
    return null;
  }

  return value.replace(/\$\{[^}:]+:-([^}]*)\}/g, '$1');
}

function configuredMigrations(root: string): string | null {
  try {
    const data = parse(readSource(join(root, 'murmur.yaml')) ?? '', { schema: 'failsafe' }) as unknown;
    const value = (data as { capabilities?: { sqlite?: { migrations?: unknown } } } | null)?.capabilities
      ?.sqlite?.migrations;

    if (value === undefined) {
      return DEFAULT_MIGRATIONS_DIR;
    }

    return typeof value === 'string' ? interpolated(value) : null;
  } catch {
    return DEFAULT_MIGRATIONS_DIR;
  }
}

function sqlFilesUnder(root: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !SKIPPED_DIRS.has(e.name))
    .flatMap((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        return sqlFilesUnder(root, path);
      }

      return e.name.endsWith('.sql') ? [relative(root, path)] : [];
    })
    .toSorted();
}

function migrationFiles(root: string, dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    return [];
  }

  return readdirSync(absolute)
    .filter((name) => name.endsWith('.sql'))
    .toSorted()
    .map((name) => relative(root, join(absolute, name)));
}

function readAll(root: string, paths: readonly string[]): SqlSource[] {
  return paths.map((path) => ({ path, text: readSource(join(root, path)) ?? '' }));
}

function testStrings(analysis: Analysis, node: FolderNode): SqlSource[] {
  return node.files
    .filter((f) => f.endsWith('.test.ts'))
    .flatMap((f) => {
      const path = relative(analysis.repo.root, join(node.dir, f));

      return sqlStringsIn(readSource(join(node.dir, f)) ?? '').map((text) => ({ path, text }));
    });
}

function sourceSets(analysis: Analysis, node: FolderNode, migrations: string | null): SourceSet[] {
  const { root } = analysis.repo;
  const fromMigrations = migrations === null ? [] : migrationFiles(root, migrations);
  const scanned = sqlFilesUnder(root, root).filter((p) => !fromMigrations.includes(p));

  return [
    { label: `sqlite migrations dir \`${migrations}\``, sources: readAll(root, fromMigrations) },
    { label: '*.sql scan', sources: readAll(root, scanned) },
    { label: 'CREATE TABLE string in a test', sources: testStrings(analysis, node) },
  ];
}

function ddlFrom(set: SourceSet, table: string): Omit<TableStorage, 'table' | 'example'> | null {
  const found = set.sources
    .map((source) => ({ path: source.path, statements: statementsFor(sqlStatements(source.text), table) }))
    .filter((f) => f.statements.length > 0);
  const statements = found.flatMap((f) => f.statements);

  if (!createsTable(statements, table)) {
    return null;
  }

  const paths = [...new Set(found.map((f) => `\`${f.path}\``))].join(', ');

  return { origin: `${paths} (${set.label})`, statements };
}

function fixtureSql(analysis: Analysis, node: FolderNode): SqlSource[] {
  const { root } = analysis.repo;
  const paths = node.files
    .filter((f) => f.startsWith('fixtures/') && f.endsWith('.sql'))
    .map((f) => relative(root, join(node.dir, f)));

  return readAll(root, paths);
}

function rowSources(analysis: Analysis, node: FolderNode): SqlSource[] {
  const others = [...analysis.repo.folders.values()].filter((n) => n.id !== node.id);

  return [node, ...others].flatMap((n) => testStrings(analysis, n).concat(fixtureSql(analysis, n)));
}

function exampleRow(sources: readonly SqlSource[], table: string): ExampleRow | null {
  for (const source of sources) {
    const sql = exampleRowIn([source.text], table);
    if (sql !== null) {
      return { path: source.path, sql };
    }
  }

  return null;
}

function lookedIn(migrations: string | null): string[] {
  return [
    ...(migrations === null ? [] : [`sqlite migrations dir \`${migrations}\``]),
    '*.sql files',
    'CREATE TABLE strings in the piece tests',
  ];
}

export function ownedStorage(analysis: Analysis, node: FolderNode): OwnedStorage | null {
  const names = namedTables(analysis, node);
  if (names.length === 0) {
    return null;
  }

  const migrations = configuredMigrations(analysis.repo.root);
  const sets = sourceSets(analysis, node, migrations);
  const rows = rowSources(analysis, node);
  const tables = names.map((table) => {
    const ddl = sets.map((set) => ddlFrom(set, table)).find((d) => d !== null) ?? null;

    return {
      table,
      origin: ddl?.origin ?? null,
      statements: ddl?.statements ?? [],
      example: exampleRow(rows, table),
    };
  });

  return { tables, looked: lookedIn(migrations) };
}

function tableText(table: TableStorage, looked: readonly string[], level: Level): string {
  if (table.origin === null) {
    return `### ${table.table}\n\nno DDL found (looked in: ${looked.join(', ')})`;
  }

  const example =
    table.example === null || level > 0
      ? ''
      : `example row (\`${table.example.path}\`): \`${table.example.sql}\``;

  return joinBlocks([
    `### ${table.table}`,
    `from ${table.origin}`,
    fence('sql', table.statements.map((s) => `${s};`).join('\n\n')),
    example,
  ]);
}

export function storageSection(storage: OwnedStorage): Section {
  return {
    id: 'storage',
    title: 'Storage',
    priority: 1,
    render: (level) =>
      joinBlocks([HEADINGS.storage, ...storage.tables.map((t) => tableText(t, storage.looked, level))]),
  };
}

export function withStorage(sections: readonly Section[], storage: OwnedStorage | null): Section[] {
  if (storage === null || sections.some((s) => s.id === 'storage')) {
    return [...sections];
  }

  const at = sections.findIndex((s) => s.id === 'capabilities') + 1;

  return [...sections.slice(0, at), storageSection(storage), ...sections.slice(at)];
}
