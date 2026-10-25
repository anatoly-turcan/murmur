import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finding, type Finding } from './finding.ts';
import { existingPaths } from './paths.ts';

function oxfmtBin(): string {
  return join(dirname(fileURLToPath(import.meta.resolve('oxfmt/package.json'))), 'bin', 'oxfmt');
}

function configArgs(root: string): string[] {
  if (existsSync(join(root, '.oxfmtrc.json'))) {
    return [];
  }

  return ['-c', fileURLToPath(import.meta.resolve('@murmur/lint/oxfmt'))];
}

interface OxfmtRun {
  readonly stdout: string;
  readonly failure: string | null;
}

function oxfmt(root: string, args: readonly string[]): OxfmtRun {
  const result = spawnSync(process.execPath, [oxfmtBin(), ...configArgs(root), ...args], {
    cwd: root,
    encoding: 'utf8',
  });

  if (result.error !== undefined) {
    throw new Error(`oxfmt did not run: ${result.error.message}`);
  }

  const failed = result.status !== 0 && result.stderr.trim() !== '';

  return { stdout: result.stdout, failure: failed ? result.stderr.trim() : null };
}

function failedRun(stderr: string): Finding {
  return finding('oxfmt/run', 'error', '.', `oxfmt failed: ${stderr}`, {
    help: 'fix the file oxfmt cannot parse, or the .oxfmtrc.json it cannot load',
  });
}

function unformatted(file: string): Finding {
  return finding('oxfmt/format', 'error', file, 'not formatted the way oxfmt writes it', {
    help: 'run murmur check --fix (or pnpm exec oxfmt) to format it',
  });
}

export function formatFiles(root: string, paths: readonly string[]): void {
  const targets = existingPaths(root, paths);
  if (targets.length > 0) {
    oxfmt(root, targets);
  }
}

export function formatFindings(root: string, paths: readonly string[]): Finding[] {
  const targets = existingPaths(root, paths);
  if (targets.length === 0) {
    return [];
  }

  const run = oxfmt(root, ['--list-different', ...targets]);
  const listed = run.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(unformatted);

  return run.failure === null ? listed : [...listed, failedRun(run.failure)];
}
