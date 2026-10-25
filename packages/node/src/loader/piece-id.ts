import { dirname, relative, sep } from 'node:path';

import { parse } from 'yaml';

export interface Frontmatter {
  readonly title: string | null;
  readonly summary: string | null;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function pieceIdOf(file: string, piecesRoot: string): string {
  return relative(piecesRoot, dirname(file)).split(sep).join('/');
}

export function envPrefixOf(id: string): string {
  return id.toUpperCase().replaceAll('/', '_').replaceAll('-', '_');
}

function text(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`frontmatter ${field} must be a string`);
  }

  return value;
}

export function parseFrontmatter(markdown: string): Frontmatter {
  const block = FRONTMATTER.exec(markdown)?.[1];
  if (block === undefined) {
    return { title: null, summary: null };
  }

  const data: unknown = parse(block, { schema: 'failsafe' }) ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('frontmatter must be a map');
  }

  const fields = data as Record<string, unknown>;

  return { title: text(fields['title'], 'title'), summary: text(fields['summary'], 'summary') };
}
