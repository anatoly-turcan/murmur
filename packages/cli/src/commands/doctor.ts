import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { Command, CommandContext } from '../command.ts';
import { isAlive, lockFile, readLock } from '../dev/lock.ts';
import { EXIT } from '../errors.ts';
import { renderTable } from '../render/table.ts';
import { findRoot } from '../root.ts';
import { transformerReport, type TransformerReport } from '../transformer-report.ts';

const PACKAGES = ['murmur', '@murmur/node', '@murmur/cli', 'zod', 'oxlint', 'typescript'];

type Lock = 'none' | 'live' | 'stale';

function packageVersion(from: string, name: string): string | null {
  let dir = from;
  while (true) {
    const file = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(file)) {
      return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? null;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
}

function pnpmVersion(): string | null {
  const result = spawnSync('pnpm', ['--version'], { encoding: 'utf8' });

  return result.status === 0 ? result.stdout.trim() : null;
}

function lockState(root: string): Lock {
  if (!existsSync(lockFile(root))) {
    return 'none';
  }

  const lock = readLock(root);

  return lock !== null && isAlive(lock.pid) ? 'live' : 'stale';
}

function oxlintExtendsResolves(root: string): boolean {
  try {
    const config = JSON.parse(readFileSync(join(root, '.oxlintrc.json'), 'utf8')) as { extends?: unknown };
    const list = Array.isArray(config.extends) ? config.extends : [];

    return list.length > 0 && list.every((path) => typeof path === 'string' && existsSync(join(root, path)));
  } catch {
    return false;
  }
}

async function appChecks(root: string, env: CommandContext['env']) {
  return {
    lock: lockState(root),
    oxlintExtends: oxlintExtendsResolves(root),
    transformer: await transformerReport(root, env['MURMUR_TRANSFORM'], packageVersion),
  };
}

async function diagnose(start: string, env: CommandContext['env']) {
  const root = findRoot(start);
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 26;
  const app = root === null ? null : await appChecks(root, env);

  return {
    node: process.versions.node,
    nodeOk,
    typescript: String(process.features.typescript),
    pnpm: pnpmVersion(),
    root,
    packages: Object.fromEntries(PACKAGES.map((name) => [name, packageVersion(root ?? start, name)])),
    ...app,
    ok: nodeOk && app !== null && app.oxlintExtends && app.transformer.works,
  };
}

function extendsLabel(resolves: boolean | undefined): string {
  if (resolves === undefined) {
    return '—';
  }

  return resolves ? 'resolves' : 'does not resolve';
}

function transformerRows(report: TransformerReport | undefined): string[][] {
  if (report === undefined) {
    return [['transformer', '—']];
  }

  const status = report.works ? 'works' : `fails: ${report.error}`;

  return [
    ['transformer', `${report.name ?? '—'} (${report.package ?? '—'} ${report.version ?? 'not installed'})`],
    ['transformer binary', report.binary ?? 'not found'],
    ['transform probe', status],
    ['register', report.registerUrl ?? '—'],
  ];
}

async function run(ctx: CommandContext): Promise<number> {
  const result = await diagnose(resolve(ctx.cwd ?? process.cwd()), ctx.env);
  if (ctx.out.json) {
    ctx.out.emit({ kind: 'doctor', ...result });
  } else {
    const rows: string[][] = [
      ['node', `${result.node}${result.nodeOk ? '' : '  (needs >= 26)'}`],
      ['typescript mode', result.typescript],
      ['pnpm', result.pnpm ?? 'not found'],
      ['root', result.root ?? 'no murmur.config.ts found'],
      ...Object.entries(result.packages).map(([name, version]) => [name, version ?? 'not installed']),
      ['dev lock', result.lock ?? '—'],
      ['.oxlintrc.json extends', extendsLabel(result.oxlintExtends)],
      ...transformerRows(result.transformer),
    ];
    ctx.out.print(renderTable(['check', 'value'], rows));
  }

  return result.ok ? EXIT.ok : EXIT.findings;
}

export const doctorCommand: Command = { usage: 'doctor', options: {}, run };
