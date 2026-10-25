import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type Diagnostic = {
  code: string;
  filename: string;
  message: string;
  labels: { span: { line: number } }[];
};

export const root = resolve(import.meta.dirname, '../../..');

export function oxlint(cwd: string, config: string, targets: string[]): Diagnostic[] {
  const result = spawnSync(join(root, 'node_modules/.bin/oxlint'), ['-c', config, '-f', 'json', ...targets], {
    cwd,
    encoding: 'utf8',
  });
  assert.ok(result.stdout.trim().startsWith('{'), result.stdout + result.stderr);

  return (JSON.parse(result.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
}

export function createSandbox(): string {
  const sandbox = mkdtempSync(join(tmpdir(), 'murmur-lint-'));
  const config = JSON.parse(readFileSync(join(root, '.oxlintrc.json'), 'utf8')) as { extends: string[] };
  config.extends = config.extends.map((path) => join(root, path));
  writeFileSync(join(sandbox, '.oxlintrc.json'), JSON.stringify(config));

  return sandbox;
}

export function removeSandbox(sandbox: string): void {
  rmSync(sandbox, { recursive: true, force: true });
}

export function writeIn(sandbox: string, path: string, source: string): string {
  const file = join(sandbox, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);

  return file;
}

export function lintInSandbox(sandbox: string, file: string, code: string): Diagnostic[] {
  return oxlint(sandbox, join(sandbox, '.oxlintrc.json'), [file]).filter((d) => d.code === code);
}
