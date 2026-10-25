import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { contextMd, copyApp, murmur, packageRoot, repoRoot, writeFiles } from './helpers.ts';

export const v2Fixture = join(import.meta.dirname, 'fixtures', 'v2');

const WORKSPACE_PATHS: readonly (readonly [string, string])[] = [
  ['../../../../node/tsconfig.app.json', '@murmur/node/tsconfig.app.json'],
  ['../../../../lint/preset.json', './node_modules/@murmur/lint/preset.json'],
];

function outsideWorkspace(file: string): string {
  const text = readFileSync(join(v2Fixture, file), 'utf8');

  return WORKSPACE_PATHS.reduce((out, [from, to]) => out.replace(from, to), text);
}

export function v2Copy(files: Readonly<Record<string, string>> = {}): {
  root: string;
  [Symbol.dispose](): void;
} {
  const app = copyApp(v2Fixture, join(packageRoot, 'node_modules'));
  writeFiles(app.root, {
    '.gitignore': 'node_modules\n.murmur\n',
    'tsconfig.json': outsideWorkspace('tsconfig.json'),
    '.oxlintrc.json': outsideWorkspace('.oxlintrc.json'),
    '.oxfmtrc.json': readFileSync(join(repoRoot, 'packages/lint/oxfmt.json'), 'utf8'),
    ...files,
  });

  return app;
}

export type Finding = { rule: string; severity: string; file: string; line?: number; message: string };

export type CheckJson = { ok: boolean; findings: Finding[] };

export function check(
  root: string,
  paths: readonly string[] = [],
): { status: number | null; json: CheckJson; stderr: string } {
  const result = murmur(['check', '--json', '--cwd', root, ...paths]);

  return { status: result.status, json: result.json<CheckJson>(), stderr: result.stderr };
}

export function edge(
  className: string,
  imports: readonly string[],
  members: readonly string[],
  decorators: readonly string[] = [],
): string {
  return [
    "import { Piece, Serve } from 'murmur';",
    '',
    "import web, { type WebRequest } from '#capabilities/web';",
    ...imports,
    '',
    ...decorators,
    `export class ${className} extends Piece() {`,
    ...members,
    '}',
    '',
  ].join('\n');
}

export function piece(id: string, source: string): Record<string, string> {
  return { [`pieces/${id}/piece.ts`]: source, [`pieces/${id}/context.md`]: contextMd(id) };
}

export function found(json: CheckJson, rule: string): Finding[] {
  return json.findings.filter((f) => f.rule === rule);
}
