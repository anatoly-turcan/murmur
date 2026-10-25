import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { walk } from './files.ts';

const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'|(?:^|\n)\s*import\s+'([^']+)'/g;

function packageName(specifier: string): string {
  const parts = specifier.split('/');

  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function isBare(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('#') && !specifier.startsWith('node:');
}

function specifiersOf(text: string): string[] {
  return [...text.matchAll(STATIC_IMPORT)].map((match) => match[1] ?? match[2] ?? '').filter(isBare);
}

export function importedPackages(dir: string): string[] {
  const files = ['src', 'bin']
    .flatMap((sub) => walk(join(dir, sub)))
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'));
  const names = files.flatMap((file) => specifiersOf(readFileSync(file, 'utf8')).map(packageName));

  return [...new Set(names)].toSorted();
}
