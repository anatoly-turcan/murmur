import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Repo } from '../analysis/types.ts';

export interface Scope {
  readonly all: boolean;
  readonly ids: ReadonlySet<string>;
}

export const EVERYTHING: Scope = { all: true, ids: new Set() };

function folderOf(repo: Repo, file: string): string | null {
  const rel = relative(repo.piecesDir, file);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }

  const parts = rel === '' ? [] : rel.split(sep);
  for (let n = parts.length; n >= 0; n--) {
    const id = parts.slice(0, n).join('/');
    const node = repo.folders.get(id);

    if (node?.kind === 'piece') {
      return id;
    }
  }

  for (let n = parts.length; n >= 1; n--) {
    const id = parts.slice(0, n).join('/');
    if (repo.folders.has(id)) {
      return id;
    }
  }

  return null;
}

const SHARED_DIRS = ['contracts', 'capabilities', 'lib'];

function isUnder(repo: Repo, dir: string, file: string): boolean {
  return relative(join(repo.root, dir), file).split(sep)[0] !== '..';
}

function isSharedFile(repo: Repo, file: string): boolean {
  return (
    repo.contractFiles.some((c) => c.file === file) || SHARED_DIRS.some((dir) => isUnder(repo, dir, file))
  );
}

export function scopeOf(repo: Repo, paths: readonly string[]): Scope {
  const files = paths.map((p) => (isAbsolute(p) ? p : resolve(repo.root, p)));
  if (files.some((file) => isSharedFile(repo, file))) {
    return EVERYTHING;
  }

  const ids = new Set(files.flatMap((file) => folderOf(repo, file) ?? []));

  return { all: false, ids };
}

export function inScope(
  repo: Repo,
  scope: Scope,
  finding: { readonly file: string; readonly pieces?: readonly string[] },
): boolean {
  if (scope.all) {
    return true;
  }

  const id = folderOf(repo, resolve(repo.root, finding.file));

  return id === null || scope.ids.has(id) || (finding.pieces ?? []).some((piece) => scope.ids.has(piece));
}

export function scopeDirs(repo: Repo, scope: Scope): string[] {
  return [...scope.ids].map((id) => relative(repo.root, join(repo.piecesDir, id)) || 'pieces');
}
