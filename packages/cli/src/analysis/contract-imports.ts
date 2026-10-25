import { join, resolve } from 'node:path';

import { parse } from './ast.ts';
import type { ContractInfo } from './types.ts';

function importedFile(root: string, dir: string, specifier: string): string {
  return specifier.startsWith('#contracts/')
    ? join(root, 'contracts', `${specifier.slice('#contracts/'.length)}.ts`)
    : resolve(dir, specifier);
}

export function importedContracts(
  contracts: readonly ContractInfo[],
  root: string,
  dir: string,
  source: string,
): Map<string, ContractInfo> {
  const found = new Map<string, ContractInfo>();
  for (const entry of parse('x.ts', source)?.imports ?? []) {
    const file = importedFile(root, dir, entry.specifier);
    for (const e of entry.entries) {
      const match = contracts.find((c) => c.file === file && c.exportName === e.imported);
      if (match !== undefined) {
        found.set(e.local, match);
      }
    }
  }

  return found;
}
