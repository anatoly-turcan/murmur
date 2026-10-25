import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const packageRoot = join(import.meta.dirname, '..');
export const repoRoot = join(packageRoot, '..', '..');
export const fixtureApp = join(import.meta.dirname, 'fixtures', 'app');
const CLI = join(packageRoot, 'bin', 'murmur.ts');

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  json<T = Record<string, unknown>>(): T;
}

export function murmur(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? packageRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...options.env },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: <T>() => {
      const lines = result.stdout.trim().split('\n');
      assert.equal(
        lines.length,
        1,
        `expected one JSON object on stdout, got:\n${result.stdout}\n${result.stderr}`,
      );

      return JSON.parse(lines[0] as string) as T;
    },
  };
}

export const BASE_FILES: Readonly<Record<string, string>> = {
  '.gitignore': 'node_modules\n.murmur\n',
  'package.json': `${JSON.stringify(
    {
      name: 'tmp-app',
      private: true,
      type: 'module',
      imports: { '#contracts/*': './contracts/*.ts' },
      dependencies: { '@murmur/node': 'workspace:*', murmur: 'workspace:*', zod: '4.6.7' },
    },
    null,
    2,
  )}\n`,
  'tsconfig.json': '{ "extends": "@murmur/node/tsconfig.app.json", "include": ["pieces", "contracts"] }\n',
  '.oxlintrc.json': '{ "extends": ["./node_modules/@murmur/lint/preset.json"] }\n',
  'murmur.config.ts': appConfig(''),
};

export function appConfig(extra: string): string {
  return [
    "import { defineApp } from '@murmur/node';",
    "import { createMemoryTransport } from '@murmur/transport-memory';",
    '',
    `export default defineApp({ name: 'tmp', transport: () => createMemoryTransport()${extra} });`,
    '',
  ].join('\n');
}

export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

export function makeApp(files: Readonly<Record<string, string>>): { root: string; [Symbol.dispose](): void } {
  const root = mkdtempSync(join(tmpdir(), 'murmur-cli-'));
  symlinkSync(join(packageRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFiles(root, {
    ...BASE_FILES,
    '.oxfmtrc.json': readFileSync(join(repoRoot, 'packages/lint/oxfmt.json'), 'utf8'),
    ...files,
  });

  return { root, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) };
}

const NOT_COPIED = new Set(['node_modules', '.murmur']);

function copied(src: string): boolean {
  const name = basename(src);

  return !NOT_COPIED.has(name) && !name.endsWith('.db');
}

export function copyApp(
  source: string,
  nodeModules = join(source, 'node_modules'),
): { root: string; [Symbol.dispose](): void } {
  const root = mkdtempSync(join(tmpdir(), 'murmur-copy-'));
  cpSync(source, root, { recursive: true, filter: copied });
  symlinkSync(nodeModules, join(root, 'node_modules'), 'dir');

  return { root, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) };
}

export function contextMd(id: string, summary = `Does ${id}.`): string {
  return `---\nsummary: ${summary}\n---\n\n# ${id}\n`;
}

export const TODO_CONTRACTS = [
  "import { Event, Query } from 'murmur';",
  "import { z } from 'zod';",
  '',
  'export class TodoCreated extends Event(',
  "  { id: z.string(), kind: z.enum(['a', 'b']) },",
  "  { name: 'todos.created' },",
  ') {}',
  '',
  "export class TodoAudited extends Event({ id: z.string() }, { name: 'todos.audited' }) {}",
  '',
  "export class TodoCountRequested extends Query({}, { count: z.number() }, { name: 'todos.count.requested' }) {}",
  '',
].join('\n');
