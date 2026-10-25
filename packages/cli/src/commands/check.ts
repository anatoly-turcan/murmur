import { analyze } from '../analysis/analyze.ts';
import { changedFiles } from '../check/changed.ts';
import { withoutStructureTwins } from '../check/dedupe.ts';
import type { Finding } from '../check/finding.ts';
import { formatFiles, formatFindings } from '../check/format.ts';
import { lintFindings } from '../check/lint.ts';
import { EVERYTHING, inScope, scopeDirs, scopeOf, type Scope } from '../check/scope.ts';
import { structureFindings } from '../check/structure.ts';
import { typeFindings } from '../check/types.ts';
import { flag, type Command, type CommandContext } from '../command.ts';
import { CliError, EXIT } from '../errors.ts';
import type { Output } from '../output.ts';
import { renderTable } from '../render/table.ts';
import { requireRoot } from '../root.ts';

const DEFAULT_PATHS = ['pieces', 'contracts', 'capabilities', 'lib'];

interface CheckResult {
  readonly structure: readonly Finding[];
  readonly lint: readonly Finding[];
  readonly types: readonly Finding[] | null;
}

async function describeApp(root: string, env: CommandContext['env']) {
  try {
    return await analyze(root, env);
  } catch (error) {
    throw new CliError(EXIT.boot, `the app cannot be described: ${(error as Error).message}`);
  }
}

function scopeFor(ctx: CommandContext, root: string, repo: Parameters<typeof scopeOf>[0]): Scope {
  const paths = [...ctx.positionals, ...(flag(ctx, 'changed') ? changedFiles(root) : [])];
  if (paths.length === 0 && !flag(ctx, 'changed')) {
    return EVERYTHING;
  }

  return scopeOf(repo, paths);
}

function lintAndFormat(root: string, paths: readonly string[], fix: boolean): Finding[] {
  if (paths.length === 0) {
    return [];
  }

  if (fix) {
    formatFiles(root, paths);
  }

  const lint = lintFindings(root, paths, fix);

  if (fix) {
    formatFiles(root, paths);
  }

  return [...lint, ...formatFindings(root, paths)];
}

function all(result: CheckResult): Finding[] {
  return [...result.structure, ...result.lint, ...(result.types ?? [])];
}

function printHuman(out: Output, findings: readonly Finding[]): void {
  if (findings.length === 0) {
    out.print('check: no findings');

    return;
  }

  const rows = findings.map((f) => [`${f.file}:${f.line}:${f.col}`, f.severity, f.rule, f.message]);
  out.print(renderTable(['location', 'severity', 'rule', 'message'], rows));
}

async function run(ctx: CommandContext): Promise<number> {
  const root = requireRoot(ctx.cwd);
  const analysis = await describeApp(root, ctx.env);
  const scope = scopeFor(ctx, root, analysis.repo);
  const paths = scope.all ? DEFAULT_PATHS : scopeDirs(analysis.repo, scope);
  const structure = structureFindings(analysis).filter((f) => inScope(analysis.repo, scope, f));
  const lint = lintAndFormat(root, paths, flag(ctx, 'fix'));
  const result: CheckResult = {
    structure,
    lint: withoutStructureTwins(structure, lint),
    types: flag(ctx, 'types') ? typeFindings(root) : null,
  };
  const findings = all(result);
  const ok = !findings.some((f) => f.severity === 'error');

  if (ctx.out.json) {
    const summary = {
      structure: result.structure.length,
      lint: result.lint.length,
      types: result.types?.length ?? null,
    };
    ctx.out.emit({ kind: 'check', ok, findings, summary });
  } else {
    printHuman(ctx.out, findings);
  }

  return ok ? EXIT.ok : EXIT.findings;
}

export const checkCommand: Command = {
  usage: 'check [--changed] [--types] [--fix] [--json] [paths…]',
  options: {
    changed: { type: 'boolean' },
    types: { type: 'boolean' },
    fix: { type: 'boolean' },
  },
  run,
};
