import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finding, type Finding } from './finding.ts';
import { existingPaths } from './paths.ts';

interface OxlintLabel {
  readonly span?: { readonly line?: number; readonly column?: number };
}

interface OxlintDiagnostic {
  readonly code?: string;
  readonly message: string;
  readonly severity?: string;
  readonly help?: string;
  readonly filename: string;
  readonly labels?: readonly OxlintLabel[];
}

function lintPackageFile(entry: string): string {
  return fileURLToPath(import.meta.resolve(`@murmur/lint/${entry}`));
}

function oxlintBin(): string {
  return join(dirname(fileURLToPath(import.meta.resolve('oxlint'))), '..', 'bin', 'oxlint');
}

function tsgolintBin(): string {
  const launcher = createRequire(import.meta.resolve('oxlint-tsgolint/package.json'));
  const exe = process.platform === 'win32' ? 'tsgolint.exe' : 'tsgolint';

  return launcher.resolve(`@oxlint-tsgolint/${process.platform}-${process.arch}/${exe}`);
}

function appConfig(root: string): string {
  const own = join(root, '.oxlintrc.json');

  return existsSync(own) ? own : lintPackageFile('preset');
}

function ruleOf(code: string | undefined): string {
  const match = /^([\w-]+)\((.+)\)$/.exec(code ?? '');

  return match === null ? (code ?? 'oxlint') : `${match[1]}/${match[2]}`;
}

function normalise(d: OxlintDiagnostic): Finding {
  const span = d.labels?.[0]?.span;

  return finding(ruleOf(d.code), d.severity === 'error' ? 'error' : 'warn', d.filename, d.message, {
    line: span?.line ?? 1,
    col: span?.column ?? 1,
    ...(d.help === undefined ? {} : { help: d.help }),
  });
}

function isCheckDiagnostic(d: OxlintDiagnostic): boolean {
  return (d.code ?? '').startsWith('murmur(') || d.severity === 'error';
}

function oxlint(root: string, args: readonly string[]): OxlintDiagnostic[] {
  const env = { ...process.env, OXLINT_TSGOLINT_PATH: tsgolintBin() };
  const result = spawnSync(process.execPath, [oxlintBin(), '-f', 'json', ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  const start = result.stdout.indexOf('{');

  if (start === -1) {
    throw new Error(`oxlint produced no JSON: ${result.stderr || result.stdout}`);
  }

  return (JSON.parse(result.stdout.slice(start)) as { diagnostics: OxlintDiagnostic[] }).diagnostics;
}

function typeAwarePass(root: string, targets: readonly string[]): OxlintDiagnostic[] {
  return oxlint(root, ['--type-aware', '-c', lintPackageFile('type-aware'), ...targets]);
}

export function lintFindings(root: string, paths: readonly string[], fix: boolean): Finding[] {
  const targets = existingPaths(root, paths);
  if (targets.length === 0) {
    return [];
  }

  const diagnostics = [
    ...oxlint(root, ['-c', appConfig(root), ...(fix ? ['--fix'] : []), ...targets]),
    ...typeAwarePass(root, targets),
  ];

  return diagnostics.filter(isCheckDiagnostic).map(normalise);
}
