import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { analyze, type Analysis } from '../analysis/analyze.ts';
import { type Include, INCLUDES } from '../analysis/context-sections.ts';
import { assembleContext, type ContextResult } from '../analysis/context.ts';
import { discover } from '../analysis/discover.ts';
import { docRef } from '../analysis/docs.ts';
import { assembleLibContext } from '../analysis/lib-context.ts';
import { libModule, libModules } from '../analysis/lib.ts';
import {
  choiceOption,
  flag,
  intOption,
  listOption,
  requirePositional,
  stringOption,
  type Command,
  type CommandContext,
} from '../command.ts';
import { EXIT, usageError } from '../errors.ts';
import { formatCount, type Output } from '../output.ts';
import { requireRoot } from '../root.ts';

const USAGE =
  'ctx <id>|lib/<module> [--with code,tests,fixtures,neighbors|all] [--budget <tokens>] [--format md|json] [--withhold-code] [--out <file>]';

function isInclude(value: string): value is Include {
  return (INCLUDES as readonly string[]).includes(value);
}

function includeOption(ctx: CommandContext): Include[] {
  const given = listOption(ctx, 'with');
  if (given.includes('all')) {
    return [...INCLUDES];
  }

  const unknown = given.filter((value) => !isInclude(value));
  if (unknown.length > 0) {
    throw usageError(`unknown --with value ${unknown.join(', ')}`, `use ${INCLUDES.join(', ')} or all`);
  }

  return given.filter(isInclude);
}

function assertKnown(analysis: Analysis, id: string): void {
  if (id !== '' && analysis.repo.folders.has(id)) {
    return;
  }

  const tail = id.split('/').at(-1) ?? id;
  const candidates = [...analysis.repo.folders.keys()].filter((key) => key !== '' && key.includes(tail));
  throw usageError(
    `no piece or folder "${id}" under pieces/`,
    candidates.length === 0 ? 'murmur catalog lists the pieces' : `did you mean: ${candidates.join(', ')}`,
  );
}

function jsonOf(result: ContextResult): { kind: string } & Record<string, unknown> {
  const { markdown: _markdown, ...rest } = result;

  return { kind: 'ctx', ...rest };
}

function capsApply(result: ContextResult): boolean {
  return result.budget === null;
}

function sizingLine(result: ContextResult, root: string): string | null {
  if (!capsApply(result) || result.sizing === 'ok' || result.sizing === 'large') {
    return null;
  }

  const cap =
    result.sizing === 'warn'
      ? `warn ≥ ${formatCount(result.limits.ctxWarnTokens)}`
      : `fail ≥ ${formatCount(result.limits.ctxFailTokens)}`;

  return `ctx: ${result.piece} is ${formatCount(result.fullTokens)} tokens in full (${cap}) — split before it grows; heuristics in ${docRef('piece-authoring', root)}`;
}

type Emitted = { kind: string } & Record<string, unknown>;

function write(out: Output, result: ContextResult, json: boolean, file: string | undefined): void {
  writeText(out, result.markdown, json ? jsonOf(result) : null, file);
}

function writeText(out: Output, text: string, json: Emitted | null, file: string | undefined): void {
  if (file !== undefined) {
    writeFileSync(file, `${json === null ? text : JSON.stringify(json)}\n`);
  } else if (json === null) {
    out.print(text);
  } else {
    out.emit(json);
  }
}

function runLib(ctx: CommandContext, id: string): number {
  const root = requireRoot(ctx.cwd);
  const module = libModule(root, id);

  if (module === null) {
    const known = libModules(root).map((m) => m.id);
    throw usageError(
      `no lib module "${id}" (lib/<module>.ts)`,
      known.length === 0 ? 'murmur new lib <name> writes one' : `lib modules: ${known.join(', ')}`,
    );
  }

  const result = assembleLibContext(discover(root), module);
  const json = choiceOption(ctx, 'format', ['md', 'json'] as const, 'md') === 'json' || ctx.out.json;
  const out = stringOption(ctx, 'out');
  const { markdown: _markdown, ...rest } = result;
  writeText(
    ctx.out,
    result.markdown,
    json ? { kind: 'ctx', ...rest } : null,
    out === undefined ? undefined : resolve(out),
  );

  return EXIT.ok;
}

async function run(ctx: CommandContext): Promise<number> {
  const raw = requirePositional(ctx, 0, 'piece id', USAGE).replace(/\/+$/, '');
  if (raw.startsWith('lib/')) {
    return runLib(ctx, raw);
  }

  const id = raw.replace(/^pieces\//, '');
  const format = choiceOption(ctx, 'format', ['md', 'json'] as const, 'md');
  const budget = intOption(ctx, 'budget') ?? null;
  const include = includeOption(ctx);
  const analysis = await analyze(requireRoot(ctx.cwd), ctx.env);
  assertKnown(analysis, id);
  const result = assembleContext(analysis, id, {
    budget,
    include,
    withholdCode: flag(ctx, 'withhold-code'),
  });
  const out = stringOption(ctx, 'out');
  write(ctx.out, result, format === 'json' || ctx.out.json, out === undefined ? undefined : resolve(out));
  const line = sizingLine(result, analysis.repo.root);
  if (line !== null) {
    ctx.out.warn(line);
  }

  return capsApply(result) && result.sizing === 'fail' ? EXIT.findings : EXIT.ok;
}

export const ctxCommand: Command = {
  usage: USAGE,
  options: {
    budget: { type: 'string' },
    format: { type: 'string' },
    with: { type: 'string' },
    'withhold-code': { type: 'boolean' },
    out: { type: 'string' },
  },
  run,
};
