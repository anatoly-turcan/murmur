import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { cacheByModified, modifiedAt } from './files.ts';

export interface Manifest {
  readonly path: string;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
}

function namesOf(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  return Object.keys(value);
}

function parseManifest(path: string): Manifest {
  try {
    const json: unknown = JSON.parse(readFileSync(path, 'utf8'));

    return {
      path,
      dependencies: namesOf(Reflect.get(Object(json), 'dependencies')),
      devDependencies: namesOf(Reflect.get(Object(json), 'devDependencies')),
    };
  } catch {
    return { path, dependencies: [], devDependencies: [] };
  }
}

const readManifest = cacheByModified(parseManifest);

export function nearestManifest(filename: string): Manifest | undefined {
  for (let dir = dirname(filename); ; dir = dirname(dir)) {
    const path = join(dir, 'package.json');
    const modified = modifiedAt(path);

    if (modified !== undefined) {
      return readManifest(path, modified);
    }

    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}
