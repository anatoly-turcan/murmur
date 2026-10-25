import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export interface Target {
  readonly root: string;
  readonly file: string;
  readonly key: string;
}

const APP_FILE = 'murmur.config.ts';
const WATCHED = new Set(['pieces', 'contracts', 'capabilities']);
const WHOLE_FOLDER = new Set(['contracts', 'capabilities']);

export function appRootFrom(start: string): string | null {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, APP_FILE))) {
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
}

function pieceDir(root: string, file: string): string {
  const pieces = join(root, 'pieces');
  for (let dir = dirname(file); dir.startsWith(pieces); dir = dirname(dir)) {
    if (existsSync(join(dir, 'piece.ts'))) {
      return dir;
    }
  }

  return dirname(file);
}

export function editTarget(file: string): Target | null {
  const root = appRootFrom(dirname(file));
  if (root === null) {
    return null;
  }

  const top = relative(root, file).split(sep)[0] ?? '';
  if (!WATCHED.has(top)) {
    return null;
  }

  const key = WHOLE_FOLDER.has(top) ? top : relative(root, pieceDir(root, file)).split(sep).join('/');

  return { root, file, key };
}

export function targetKey(target: Target): string {
  return `${target.root}\u0000${target.key}`;
}

export function uniqueTargets(targets: readonly Target[]): Target[] {
  return [...new Map(targets.map((target) => [targetKey(target), target])).values()];
}
