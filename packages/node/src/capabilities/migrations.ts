import type { Stats } from 'node:fs';
import { glob, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { SqliteError } from './sqlite-error.ts';

export interface MigrationFile {
  readonly name: string;
  readonly path: string;
}

export interface MigrationPlan {
  readonly files: readonly MigrationFile[];
  readonly unmatched: readonly string[];
}

export interface MigrationReport extends MigrationPlan {
  readonly applied: readonly string[];
}

export const DEFAULT_MIGRATIONS: readonly string[] = ['pieces/**/schema.sql', 'migrations/*.sql'];

interface SourceFiles {
  readonly source: string;
  readonly files: readonly MigrationFile[];
}

const GLOB_CHARACTERS = /[*?[\]{}]/;

function asPosix(path: string): string {
  return path.split(sep).join('/');
}

function byName(a: MigrationFile, b: MigrationFile): number {
  if (a.name === b.name) {
    return 0;
  }

  return a.name < b.name ? -1 : 1;
}

function relativeFile(root: string, path: string): MigrationFile {
  return { name: asPosix(relative(root, path)), path };
}

async function globbed(root: string, pattern: string): Promise<MigrationFile[]> {
  const found = await Array.fromAsync(glob(pattern, { cwd: root }));

  return found.map((path) => relativeFile(root, resolve(root, path))).toSorted(byName);
}

async function inDirectory(directory: string): Promise<MigrationFile[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).toSorted();

  return files.map((file) => ({ name: file, path: join(directory, file) }));
}

async function existing(root: string, source: string): Promise<Stats> {
  try {
    return await stat(resolve(root, source));
  } catch (error) {
    if (Reflect.get(Object(error), 'code') === 'ENOENT') {
      throw new SqliteError(`sqlite migrations: ${source} not found under ${root}`, { cause: error });
    }

    throw error;
  }
}

async function literal(root: string, source: string): Promise<MigrationFile[]> {
  const path = resolve(root, source);
  if ((await existing(root, source)).isDirectory()) {
    return inDirectory(path);
  }

  return [relativeFile(root, path)];
}

async function filesOf(root: string, source: string): Promise<SourceFiles> {
  if (GLOB_CHARACTERS.test(source)) {
    return { source, files: await globbed(root, source) };
  }

  return { source, files: await literal(root, source) };
}

function withoutRepeats(files: readonly MigrationFile[]): MigrationFile[] {
  const seen = new Set<string>();

  return files.filter((file) => {
    const repeated = seen.has(file.name);
    seen.add(file.name);

    return !repeated;
  });
}

export async function planMigrations(root: string, sources: readonly string[]): Promise<MigrationPlan> {
  const lists = await Promise.all(sources.map((source) => filesOf(root, source)));
  const unmatched = lists.filter((list) => list.files.length === 0).map((list) => list.source);

  return { files: withoutRepeats(lists.flatMap((list) => list.files)), unmatched };
}
