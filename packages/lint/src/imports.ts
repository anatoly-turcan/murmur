import { dirname, resolve } from 'node:path';

import { isInside } from './paths.ts';
import type { AstNode, Visitors } from './types.ts';

const importNodes = [
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
  'ImportExpression',
];

export function isRelative(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

export function isBare(specifier: string): boolean {
  return !isRelative(specifier) && !specifier.startsWith('/');
}

export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');

  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
}

export function resolveFrom(filename: string, specifier: string): string {
  return resolve(dirname(filename), specifier);
}

export function resolvesOutside(filename: string, specifier: string, dir: string): boolean {
  return !isInside(dir, resolveFrom(filename, specifier));
}

export function specifierOf(node: AstNode): string | undefined {
  const value = node.source?.value;

  return typeof value === 'string' ? value : undefined;
}

export function onImports(check: (node: AstNode, specifier: string) => void): Visitors {
  const visit = (node: AstNode) => {
    const specifier = specifierOf(node);
    if (specifier !== undefined) {
      check(node, specifier);
    }
  };

  return Object.fromEntries(importNodes.map((type) => [type, visit]));
}
