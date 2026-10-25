import type { Finding } from './finding.ts';

const STRUCTURE_TWIN: Readonly<Record<string, string>> = {
  'murmur/emit-declared': 'emit-undeclared',
  'murmur/piece-exports-one-class': 'piece-exports-one-class',
  'murmur/one-piece-per-folder': 'one-piece-per-folder',
};

function locate(rule: string, finding: Finding): string {
  return `${rule}\0${finding.file}\0${finding.line}`;
}

export function withoutStructureTwins(structure: readonly Finding[], lint: readonly Finding[]): Finding[] {
  const reported = new Set(structure.map((f) => locate(f.rule, f)));

  return lint.filter((f) => {
    const twin = STRUCTURE_TWIN[f.rule];

    return twin === undefined || !reported.has(locate(twin, f));
  });
}
