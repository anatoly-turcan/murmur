import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';

import { oxlint, root } from './oxlint.ts';
import { fixtureApp } from './tester.ts';

type Finding = { rule: string; file: string; line: number };

const styleFixture = 'pieces/todos/style.ts';

function byPosition(a: Finding, b: Finding): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule);
}

function findings(cwd: string, targets: string[]): Finding[] {
  return oxlint(cwd, '.oxlintrc.json', targets)
    .map((d) => ({
      rule: d.code.replace(/^murmur\((.*)\)$/, 'murmur/$1'),
      file: relative(cwd, join(cwd, d.filename)),
      line: d.labels[0]?.span.line ?? 0,
    }))
    .toSorted(byPosition);
}

function copyOfFixtureApp(): string {
  const copy = mkdtempSync(join(tmpdir(), 'murmur-lint-fix-'));
  cpSync(fixtureApp, copy, { recursive: true });
  writeFileSync(
    join(copy, '.oxlintrc.json'),
    JSON.stringify({ extends: [join(root, 'packages/lint/preset.json')] }),
  );

  return copy;
}

describe('oxlint on the fixture app (preset extended by path)', () => {
  test('the fixture .oxlintrc.json extends the preset by file path', () => {
    const config = JSON.parse(readFileSync(join(fixtureApp, '.oxlintrc.json'), 'utf8')) as {
      extends: string[];
    };
    assert.deepEqual(config.extends, ['../../../preset.json']);
  });

  test('reports exactly the golden {rule, file, line} set', () => {
    const golden = JSON.parse(readFileSync(join(fixtureApp, '../app.golden.json'), 'utf8')) as Finding[];
    assert.deepEqual(findings(fixtureApp, ['.']), golden.toSorted(byPosition));
  });

  test('--fix makes the style fixture clean in one pass', () => {
    const copy = copyOfFixtureApp();

    try {
      assert.ok(findings(copy, [styleFixture]).length > 0);
      oxlint(copy, '.oxlintrc.json', ['--fix', styleFixture]);
      assert.deepEqual(findings(copy, [styleFixture]), []);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  test('oxlint -c preset.json parses and lints a clean file', () => {
    const diagnostics = oxlint(root, 'packages/lint/preset.json', ['packages/lint/src/plugin.ts']);
    assert.deepEqual(diagnostics, []);
  });
});
