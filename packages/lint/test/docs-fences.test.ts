import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { oxlint, root } from './oxlint.ts';

type Fence = { path: string | undefined; language: string; code: string; line: number };
type CaptionedFence = Fence & { path: string };

const preview = join(root, 'docs/api-preview.md');
const captionPattern = /^`([^`]+\.(?:ts|json))`/;
const openPattern = /^```(\w+)\s*$/;

function captionBefore(lines: readonly string[], index: number): string | undefined {
  const previous = lines.slice(0, index).findLast((line) => line.trim() !== '');

  return captionPattern.exec(previous ?? '')?.[1];
}

function closingIndex(lines: readonly string[], from: number): number {
  const index = lines.findIndex((line, at) => at > from && line.startsWith('```'));

  return index === -1 ? lines.length : index;
}

function allFences(markdown: string): Fence[] {
  const lines = markdown.split('\n');
  const fences: Fence[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const language = openPattern.exec(lines[index] ?? '')?.[1];
    if (language === undefined) {
      continue;
    }

    const end = closingIndex(lines, index);
    const path = captionBefore(lines, index);

    fences.push({ path, language, code: `${lines.slice(index + 1, end).join('\n')}\n`, line: index + 1 });
    index = end;
  }

  return fences;
}

function isCaptioned(fence: Fence): fence is CaptionedFence {
  return fence.path !== undefined;
}

function writeFences(dir: string, fences: readonly CaptionedFence[]): void {
  for (const fence of fences) {
    const file = join(dir, fence.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fence.code);
  }

  writeFileSync(
    join(dir, '.oxlintrc.json'),
    JSON.stringify({ extends: [join(root, 'packages/lint/preset.json')] }),
  );
}

describe('docs/api-preview.md fenced ts blocks pass their own rules', () => {
  const everyFence = allFences(readFileSync(preview, 'utf8'));
  const fences = everyFence.filter(isCaptioned);
  const uncaptionedTs = everyFence.filter((fence) => fence.language === 'ts' && !isCaptioned(fence));
  const tsPaths = fences.filter((fence) => fence.language === 'ts').map((fence) => fence.path);
  let scratch = '';

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'murmur-docs-fences-'));
    writeFences(scratch, fences);
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  test('every ts fence is captioned with its file path, and package.json is among the fences', () => {
    const lines = uncaptionedTs.map((fence) => fence.line).join(', ');
    assert.deepEqual(
      uncaptionedTs,
      [],
      `ts fences without a file-path caption at api-preview.md lines ${lines}`,
    );
    assert.ok(tsPaths.length >= 15, `found ${tsPaths.length} captioned ts fences`);
    assert.ok(tsPaths.includes('pieces/todos/piece.ts'));
    assert.ok(fences.some((fence) => fence.path === 'package.json'));
  });

  test('oxfmt --check with the preset formatting passes', () => {
    const result = spawnSync(
      join(root, 'node_modules/.bin/oxfmt'),
      ['--check', '-c', join(root, 'packages/lint/oxfmt.json'), ...tsPaths],
      { cwd: scratch, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test('oxlint with the preset reports nothing', () => {
    const diagnostics = oxlint(scratch, '.oxlintrc.json', tsPaths).map(
      (d) => `${d.filename}:${d.labels[0]?.span.line ?? 0} ${d.code} ${d.message}`,
    );
    assert.deepEqual(diagnostics, []);
  });
});
