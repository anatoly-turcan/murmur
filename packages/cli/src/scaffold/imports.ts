import { join, relative, resolve } from 'node:path';

import type { ContractInfo } from '../analysis/types.ts';

export interface ImportSpec {
  readonly from: string;
  readonly names?: readonly string[];
  readonly defaultName?: string;
  readonly json?: boolean;
}

function groupOf(from: string): number {
  if (from.startsWith('node:')) {
    return 0;
  }

  if (from.startsWith('#')) {
    return 2;
  }

  if (from.startsWith('.')) {
    return 3;
  }

  return 1;
}

const byLower = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
const bare = (name: string) => name.replace(/^type /, '');

function line(spec: ImportSpec): string {
  const names = [...(spec.names ?? [])].toSorted((a, b) => byLower(bare(a), bare(b)));
  const parts = [
    ...(spec.defaultName === undefined ? [] : [spec.defaultName]),
    ...(names.length === 0 ? [] : [`{ ${names.join(', ')} }`]),
  ];
  const attributes = spec.json === true ? " with { type: 'json' }" : '';

  return `import ${parts.join(', ')} from '${spec.from}'${attributes};`;
}

export function importBlock(specs: readonly ImportSpec[]): string {
  const merged = new Map<string, ImportSpec>();
  for (const spec of specs) {
    const existing = merged.get(spec.from);
    merged.set(spec.from, {
      ...existing,
      ...spec,
      names: [...new Set([...(existing?.names ?? []), ...(spec.names ?? [])])],
    });
  }

  const groups = Map.groupBy([...merged.values()], (spec) => groupOf(spec.from));

  return [0, 1, 2, 3]
    .flatMap((g) => {
      const members = groups.get(g);
      if (members === undefined) {
        return [];
      }

      return [
        members
          .toSorted((a, b) => byLower(a.from, b.from))
          .map(line)
          .join('\n'),
      ];
    })
    .join('\n\n');
}

function posix(path: string): string {
  return path.split('\\').join('/');
}

export function contractSource(root: string, fromDir: string, contract: ContractInfo): string {
  const file = resolve(root, contract.file);
  if (contract.visibility === 'public') {
    return `#contracts/${posix(relative(join(root, 'contracts'), file)).replace(/\.ts$/, '')}`;
  }

  const path = posix(relative(fromDir, file));

  return path.startsWith('.') ? path : `./${path}`;
}
