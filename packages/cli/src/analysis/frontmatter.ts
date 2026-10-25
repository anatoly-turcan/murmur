import { parse } from 'yaml';

export interface Frontmatter {
  readonly present: boolean;
  readonly title: string | null;
  readonly summary: string | null;
  readonly error: string | null;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function field(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];

  return typeof value === 'string' && value !== '' ? value : null;
}

export function parseFrontmatter(markdown: string): Frontmatter {
  const block = FRONTMATTER.exec(markdown)?.[1];
  if (block === undefined) {
    return { present: false, title: null, summary: null, error: null };
  }

  try {
    const data: unknown = parse(block, { schema: 'failsafe' }) ?? {};
    if (typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('frontmatter must be a map');
    }

    const fields = data as Record<string, unknown>;

    return { present: true, title: field(fields, 'title'), summary: field(fields, 'summary'), error: null };
  } catch (error) {
    return { present: true, title: null, summary: null, error: (error as Error).message };
  }
}

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER, '').trimStart();
}
