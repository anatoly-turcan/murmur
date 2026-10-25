import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function existingPaths(root: string, paths: readonly string[]): string[] {
  return paths.filter((path) => existsSync(join(root, path)));
}
