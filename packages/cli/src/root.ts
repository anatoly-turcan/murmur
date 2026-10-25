import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { usageError } from './errors.ts';

export const APP_FILE = 'murmur.config.ts';

export function findRoot(from: string): string | null {
  let dir = resolve(from);
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

export function requireRoot(cwd: string | undefined): string {
  if (cwd !== undefined) {
    const root = resolve(cwd);
    if (!existsSync(join(root, APP_FILE))) {
      throw usageError(`no ${APP_FILE} in ${root}`, 'pass the app root via --cwd');
    }

    return root;
  }

  const root = findRoot(process.cwd());
  if (root === null) {
    throw usageError(
      `no ${APP_FILE} found upward from ${process.cwd()}`,
      'run inside a murmur app or pass --cwd',
    );
  }

  return root;
}
