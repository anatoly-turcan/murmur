import { relative } from 'node:path';

import { exportedNames, importersOf, libTest, type LibModule, moduleSignatures } from './lib.ts';
import { fence, joinBlocks } from './markdown.ts';
import { readSource } from './source-checks.ts';
import { estimateTokens } from './tokens.ts';
import type { Repo } from './types.ts';

export interface LibSection {
  readonly id: string;
  readonly title: string;
  readonly tokens: number;
  readonly text: string;
}

export interface LibContextResult {
  readonly module: string;
  readonly markdown: string;
  readonly sections: readonly LibSection[];
  readonly tokens: number;
}

const RUN = 'pnpm exec murmur';

export const LIB_PURITY =
  '> pure module, no context.md: its signatures and tests are its source of truth. Imports `node:*` without I/O, `zod`, `murmur`, `@murmur/node/lib`, `#contracts/*` and `#lib/*`; no `#capabilities`, no top-level `let` (lint `lib-pure`).';

function importLine(module: LibModule): string {
  const names = exportedNames(module);

  return names.length === 0
    ? `\`import '${module.alias}';\``
    : `\`import { ${names.join(', ')} } from '${module.alias}';\``;
}

function header(repo: Repo, module: LibModule, test: string | null): string {
  const importers = importersOf(repo, module);
  const path = relative(repo.root, module.file);

  return joinBlocks([
    `# Lib: ${module.id}`,
    LIB_PURITY,
    [
      `- file: \`${path}\``,
      `- import: ${importLine(module)}`,
      ...(test === null ? [] : [`- test: \`${RUN} test ${relative(repo.root, test)}\``]),
      `- check: \`${RUN} check ${path}\``,
      `- imported by: ${importers.length === 0 ? '(no piece)' : importers.map((id) => `\`${id}\``).join(', ')}`,
    ].join('\n'),
  ]);
}

function tests(root: string, test: string | null): string {
  if (test === null) {
    return joinBlocks(['## Tests', '(no tests: add `lib/<module>.test.ts`)']);
  }

  return joinBlocks(['## Tests', `### ${relative(root, test)}`, fence('ts', readSource(test) ?? '')]);
}

function section(id: string, title: string, text: string): LibSection {
  return { id, title, tokens: estimateTokens(text), text };
}

export function assembleLibContext(repo: Repo, module: LibModule): LibContextResult {
  const test = libTest(module);
  const sections = [
    section('header', 'Header', header(repo, module, test)),
    section('signatures', 'Signatures', joinBlocks(['## Signatures', fence('ts', moduleSignatures(module))])),
    section('tests', 'Tests', tests(repo.root, test)),
  ];

  return {
    module: module.id,
    markdown: sections.map((s) => s.text).join('\n\n'),
    sections,
    tokens: sections.reduce((n, s) => n + s.tokens, 0),
  };
}
