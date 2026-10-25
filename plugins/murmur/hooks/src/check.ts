import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

import type { Target } from './target.ts';

export interface Finding {
  readonly rule: string;
  readonly severity: 'error' | 'warn';
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly message: string;
  readonly help?: string;
}

export type CheckOutcome =
  | { readonly kind: 'report'; readonly findings: readonly Finding[] }
  | { readonly kind: 'failure'; readonly message: string };

const TIMEOUT_MS = 100_000;

function murmurCommand(root: string): readonly string[] {
  try {
    const manifestPath = createRequire(join(root, 'package.json')).resolve('@murmur/cli/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: Record<string, string> };

    return [process.execPath, join(dirname(manifestPath), manifest.bin['murmur'] ?? 'bin/murmur.ts')];
  } catch {
    return ['pnpm', 'exec', 'murmur'];
  }
}

function parseReport(stdout: string): readonly Finding[] | null {
  try {
    const json = JSON.parse(stdout) as { kind?: unknown; findings?: unknown };

    return json.kind === 'check' && Array.isArray(json.findings) ? (json.findings as Finding[]) : null;
  } catch {
    return null;
  }
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-5).join('\n');
}

function scopeArgs(target: Target): string[] {
  if (target.file === target.root || !existsSync(target.file)) {
    return [];
  }

  return [relative(target.root, target.file)];
}

export function runCheck(target: Target): CheckOutcome {
  const [command = 'pnpm', ...prefix] = murmurCommand(target.root);
  const args = [...prefix, 'check', ...scopeArgs(target), '--json', '--cwd', target.root];
  const result = spawnSync(command, args, { cwd: target.root, encoding: 'utf8', timeout: TIMEOUT_MS });
  const findings = result.status === 0 || result.status === 1 ? parseReport(result.stdout) : null;

  if (findings !== null) {
    return { kind: 'report', findings };
  }

  return {
    kind: 'failure',
    message: tail(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`),
  };
}
