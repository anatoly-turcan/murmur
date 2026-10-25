import { glob } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface Discovered {
  readonly pieces: readonly string[];
  readonly internalContracts: readonly string[];
  readonly contracts: readonly string[];
  readonly capabilities: readonly string[];
}

const skipped = (path: string) => basename(path) === 'node_modules';

async function find(root: string, pattern: string): Promise<string[]> {
  const found = await Array.fromAsync(glob(pattern, { cwd: root, exclude: skipped }));

  return found
    .filter((path) => !path.endsWith('.test.ts') && !path.split(/[\\/]/).includes('node_modules'))
    .map((path) => join(root, path))
    .toSorted();
}

export async function discover(root: string, piecesDir: string): Promise<Discovered> {
  const [pieces, internalContracts, contracts, capabilities] = await Promise.all([
    find(root, `${piecesDir}/**/piece.ts`),
    find(root, `${piecesDir}/**/contracts.ts`),
    find(root, 'contracts/*.ts'),
    find(root, 'capabilities/*/capability.ts'),
  ]);

  return { pieces, internalContracts, contracts, capabilities };
}
