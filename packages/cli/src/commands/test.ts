import { glob } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { run as runTests, type TestsStream } from 'node:test';

import { discover, isRegenerationLeaf, isWithin } from '../analysis/discover.ts';
import type { Repo } from '../analysis/types.ts';
import { appExecArgv } from '../app-exec-argv.ts';
import { flag, stringOption, type Command, type CommandContext } from '../command.ts';
import { EXIT } from '../errors.ts';
import { relaunchWith, runChild } from '../relaunch.ts';
import { requireRoot } from '../root.ts';

const DEFAULT_GLOBS = [
  'pieces/**/*.test.ts',
  'contracts/**/*.test.ts',
  'capabilities/**/*.test.ts',
  'lib/**/*.test.ts',
];
const SOURCE_MAPS_FLAG = '--enable-source-maps';
const COVERAGE_INCLUDE = 'pieces/**';
const COVERAGE_EXCLUDE = '**/*.test.ts';
const COVERAGE_ARGS = [
  '--experimental-test-coverage',
  `--test-coverage-include=${COVERAGE_INCLUDE}`,
  `--test-coverage-exclude=${COVERAGE_EXCLUDE}`,
];

interface Failure {
  readonly name: string;
  readonly file: string | undefined;
  readonly message: string;
  readonly stack: string | undefined;
}

interface FileCoverage {
  readonly file: string;
  readonly linePercent: number;
  readonly uncoveredLines: number[];
}

interface CoverageEventData {
  readonly summary: {
    readonly files: readonly {
      readonly path: string;
      readonly coveredLinePercent: number;
      readonly lines: readonly { readonly line: number; readonly count: number }[];
    }[];
  };
}

interface TestEventData {
  readonly name: string;
  readonly file?: string;
  readonly skip?: unknown;
  readonly todo?: unknown;
  readonly details: { readonly type?: string; readonly error?: Error & { cause?: unknown } };
}

async function globFiles(root: string, pattern: string): Promise<string[]> {
  const found = await Array.fromAsync(
    glob(pattern, { cwd: root, exclude: (p) => p.includes('node_modules') }),
  );

  return found.map((path) => join(root, path));
}

function folderTests(repo: Repo, id: string): string[] | null {
  const node = repo.folders.get(id);
  if (node === undefined) {
    return null;
  }

  if (node.kind === 'piece' || isRegenerationLeaf(node)) {
    return node.files.filter((f) => f.endsWith('.test.ts')).map((f) => join(node.dir, f));
  }

  const scenario = node.files.includes('scenario.test.ts') ? [join(node.dir, 'scenario.test.ts')] : [];
  const descendants = [...repo.folders.values()].filter(
    (n) => n.kind === 'piece' && n.id !== id && isWithin(n.id, id),
  );

  return [...scenario, ...descendants.flatMap((n) => folderTests(repo, n.id) ?? [])];
}

async function resolveFiles(root: string, targets: readonly string[]): Promise<string[]> {
  if (targets.length === 0) {
    return (await Promise.all(DEFAULT_GLOBS.map((p) => globFiles(root, p)))).flat().toSorted();
  }

  const repo = discover(root);
  const files: string[] = [];

  for (const target of targets) {
    const id = target.replace(/^pieces\/?/, '').replace(/\/+$/, '');
    files.push(...(folderTests(repo, id) ?? (await globFiles(root, target))));
  }

  return [...new Set(files)];
}

function failureOf(data: TestEventData): Failure {
  const error = data.details.error;
  const cause = error?.cause instanceof Error ? error.cause : error;

  return { name: data.name, file: data.file, message: cause?.message ?? 'failed', stack: cause?.stack };
}

function startRun(ctx: CommandContext, root: string, files: string[]): TestsStream {
  const pattern = stringOption(ctx, 'name');
  const coverage = flag(ctx, 'coverage');

  return runTests({
    files,
    cwd: root,
    execArgv: appExecArgv(root),
    ...(pattern === undefined ? {} : { testNamePattern: pattern }),
    ...(coverage
      ? { coverage, coverageIncludeGlobs: [COVERAGE_INCLUDE], coverageExcludeGlobs: [COVERAGE_EXCLUDE] }
      : {}),
  });
}

function coverageOf(root: string, data: CoverageEventData): FileCoverage[] {
  return data.summary.files.map((file) => ({
    file: relative(root, file.path),
    linePercent: Math.round(file.coveredLinePercent * 100) / 100,
    uncoveredLines: file.lines.filter((line) => line.count === 0).map((line) => line.line),
  }));
}

async function runJson(ctx: CommandContext, root: string, files: string[]): Promise<number> {
  const started = performance.now();
  const totals = { passed: 0, failed: 0, skipped: 0 };
  const failures: Failure[] = [];
  let coverage: FileCoverage[] | undefined;

  for await (const event of startRun(ctx, root, files)) {
    if (event.type === 'test:coverage') {
      coverage = coverageOf(root, event.data as CoverageEventData);
      continue;
    }

    const data = event.data as TestEventData;
    if ((event.type !== 'test:pass' && event.type !== 'test:fail') || data.details.type === 'suite') {
      continue;
    }

    if (data.skip !== undefined || data.todo !== undefined) {
      totals.skipped++;
    } else if (event.type === 'test:pass') {
      totals.passed++;
    } else {
      totals.failed++;
      failures.push(failureOf(data));
    }
  }

  const durationMs = Math.round(performance.now() - started);
  ctx.out.emit({
    kind: 'test',
    ...totals,
    durationMs,
    failures,
    ...(coverage === undefined ? {} : { coverage }),
  });

  return totals.failed > 0 ? EXIT.findings : EXIT.ok;
}

async function runHuman(ctx: CommandContext, root: string, files: string[]): Promise<number> {
  const pattern = stringOption(ctx, 'name');
  const args = [
    ...appExecArgv(root),
    '--test',
    ...(pattern === undefined ? [] : ['--test-name-pattern', pattern]),
    ...(flag(ctx, 'coverage') ? COVERAGE_ARGS : []),
    ...(flag(ctx, 'watch') ? ['--watch'] : []),
    ...files,
  ];
  const code = await runChild(args, root);

  if (code === EXIT.interrupted) {
    return code;
  }

  return code === 0 ? EXIT.ok : EXIT.findings;
}

function needsSourceMapFlag(ctx: CommandContext): boolean {
  return ctx.out.json && flag(ctx, 'coverage') && !process.execArgv.includes(SOURCE_MAPS_FLAG);
}

function detachFromParentRunner(): void {
  delete process.env['NODE_TEST_CONTEXT'];
}

async function run(ctx: CommandContext): Promise<number> {
  const root = requireRoot(ctx.cwd);

  if (needsSourceMapFlag(ctx)) {
    return relaunchWith([SOURCE_MAPS_FLAG]);
  }

  detachFromParentRunner();
  const files = await resolveFiles(root, ctx.positionals);
  if (files.length === 0) {
    if (ctx.out.json) {
      ctx.out.emit({ kind: 'test', passed: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] });
    } else {
      ctx.out.print('test: no test files matched');
    }

    return EXIT.ok;
  }

  return ctx.out.json ? runJson(ctx, root, files) : runHuman(ctx, root, files);
}

export const testCommand: Command = {
  usage: 'test [piece|glob…] [--watch] [--name <pattern>] [--coverage] [--json]',
  options: {
    watch: { type: 'boolean' },
    name: { type: 'string' },
    coverage: { type: 'boolean' },
  },
  run,
};
