import { laneTexts } from './context-lanes.ts';

const CLAUSE = /^(?:(?:owns|reads|writes)\s+)?tables?\b|^(?:owns|reads|writes)\b/i;
const IDENTIFIER = /^[A-Za-z_]\w*$/;

function singleName(item: string): string {
  const words = item.trim().split(/\s+/);

  return words.length === 1 && IDENTIFIER.test(words[0] as string) ? (words[0] as string) : '';
}

function tablesInClause(clause: string): string[] {
  const trimmed = clause.trim();
  if (!CLAUSE.test(trimmed)) {
    return [];
  }

  const names = trimmed
    .replace(CLAUSE, '')
    .replaceAll('`', '')
    .split(/,|\s+and\s+/)
    .map(singleName);
  const end = names.indexOf('');

  return end === -1 ? names : names.slice(0, end);
}

function tablesInText(text: string): string[] {
  return [...text.matchAll(/\(([^)]*)\)/g)].flatMap((m) =>
    (m[1] as string).split(';').flatMap(tablesInClause),
  );
}

export function tablesNamedIn(markdown: string): string[] {
  return [...new Set((laneTexts(markdown).needs ?? []).flatMap(tablesInText))];
}
