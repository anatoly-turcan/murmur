import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { createSandbox, lintInSandbox, removeSandbox, root, writeIn } from './oxlint.ts';

const ANY = 'typescript(no-explicit-any)';
const NON_NULL = 'typescript(no-non-null-assertion)';
const RETURN_TYPE = 'typescript(explicit-module-boundary-types)';
const METHOD_RETURN_TYPE = 'murmur(method-return-type)';

const LOOSE = [
  'export function first(items: any[]) {',
  '  return items[0]!;',
  '}',
  '',
  'export class Box {',
  '  open(): number {',
  '    return 1;',
  '  }',
  '',
  '  shut() {',
  '    return 0;',
  '  }',
  '}',
  '',
].join('\n');

const HIDDEN_METHODS = [
  'export class Box {',
  '  private hidden() {}',
  '',
  '  #secret() {',
  '    return [];',
  '  }',
  '}',
  '',
  'class Local {',
  '  load() {}',
  '}',
  '',
  'export const local = new Local();',
  '',
].join('\n');

const NON_EXHAUSTIVE = [
  "type Kind = 'query' | 'command' | 'event';",
  '',
  'export function label(kind: Kind): string {',
  '  switch (kind) {',
  "    case 'query':",
  "      return 'Q';",
  "    case 'command':",
  "      return 'C';",
  '  }',
  '',
  "  return '?';",
  '}',
  '',
].join('\n');

let sandbox = '';

function linesOf(file: string, code: string): number[] {
  return lintInSandbox(sandbox, file, code).map((d) => d.labels[0]?.span.line ?? 0);
}

describe('strict preset rules (owner, 2026-10-25)', () => {
  before(() => {
    sandbox = createSandbox();
  });

  after(() => removeSandbox(sandbox));

  test('any, a non-null assertion and a missing return type on an exported function or method are errors', () => {
    const file = writeIn(sandbox, 'src/loose.ts', LOOSE);

    assert.deepEqual(linesOf(file, ANY), [1]);
    assert.deepEqual(linesOf(file, NON_NULL), [2]);
    assert.deepEqual(linesOf(file, RETURN_TYPE), [1, 10]);
    assert.deepEqual(linesOf(file, METHOD_RETURN_TYPE), [10]);
  });

  test('private, #private and non-exported class methods need a return type too', () => {
    const file = writeIn(sandbox, 'src/hidden.ts', HIDDEN_METHODS);

    assert.deepEqual(linesOf(file, RETURN_TYPE), []);
    assert.deepEqual(linesOf(file, METHOD_RETURN_TYPE), [2, 4, 10]);
  });

  test('the shipped type-aware config (@murmur/lint/type-aware) reports a switch that misses a case of a union', () => {
    writeIn(
      sandbox,
      'tsconfig.json',
      JSON.stringify({
        extends: `${root}/tsconfig.base.json`,
        compilerOptions: { types: [] },
        include: ['src'],
      }),
    );
    writeIn(sandbox, 'src/kind.ts', NON_EXHAUSTIVE);
    const result = spawnSync(
      `${root}/node_modules/.bin/oxlint`,
      ['--type-aware', '-c', `${root}/packages/lint/type-aware.json`, '-f', 'unix', 'src/kind.ts'],
      {
        cwd: sandbox,
        encoding: 'utf8',
        env: { ...process.env, OXLINT_TSGOLINT_PATH: `${root}/node_modules/.bin/tsgolint` },
      },
    );

    assert.match(result.stdout, /Cases not matched: "event"/);
  });

  test('oxlint --fix with the preset keeps a bare `export {};`', () => {
    const file = writeIn(sandbox, 'src/empty.ts', 'export {};\n');
    const result = spawnSync(
      `${root}/node_modules/.bin/oxlint`,
      ['-c', '.oxlintrc.json', '--fix', 'src/empty.ts'],
      {
        cwd: sandbox,
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(file, 'utf8'), 'export {};\n');
  });
});
