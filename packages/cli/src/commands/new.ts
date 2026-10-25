import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { validateName, validatePieceId } from 'murmur';

import { analyze, type Analysis } from '../analysis/analyze.ts';
import { readPackageImports } from '../analysis/app-files.ts';
import { isWithin } from '../analysis/discover.ts';
import type { ContractInfo, ContractKind } from '../analysis/types.ts';
import { formatFiles } from '../check/format.ts';
import {
  choiceOption,
  flag,
  listOption,
  requirePositional,
  stringOption,
  type Command,
  type CommandContext,
} from '../command.ts';
import { CliError, EXIT, usageError } from '../errors.ts';
import { requireRoot } from '../root.ts';
import { planApp } from '../scaffold/app.ts';
import { planClassContract, type ClassContractPlan } from '../scaffold/class-contract.ts';
import { planClassPieceFiles } from '../scaffold/class-piece.ts';
import { classPiecePlan } from '../scaffold/class-plan.ts';
import { libNameProblem, planLib } from '../scaffold/lib.ts';
import { parseKeyTypes } from '../scaffold/names.ts';
import { groupContextFile, type PlannedFile } from '../scaffold/piece.ts';

const USAGE = [
  'new piece <path> [--handles <Contract>[,…]] [--emits <Contract>[,…]] [--needs field=cap[,…]] [--config key:type[,…]]',
  '                 [--serve \'<verb> /path[=Contract]\'[,…]] [--edge] [--idempotent] [--summary "<one line>"] [--dry-run] [--force]',
  '  new contract <ClassName> --domain <file> --kind query|command|event|guard [--input key:type,…] [--output key:type,…|Model|Model?] [--name <wire>] [--dry-run]',
  '  new lib <name> [--dry-run] [--force]',
  '  new app <dir> [--transport memory] [--registry <url>]',
].join('\n');

interface WriteResult {
  readonly created: string[];
  readonly skipped: string[];
}

function writeFiles(
  root: string,
  files: readonly PlannedFile[],
  force: boolean,
  dryRun: boolean,
): WriteResult {
  const result: WriteResult = { created: [], skipped: [] };
  for (const file of files) {
    const path = relative(root, file.path);
    if (existsSync(file.path) && !force) {
      result.skipped.push(path);
      continue;
    }

    result.created.push(path);

    if (dryRun) {
      continue;
    }

    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
  }

  return result;
}

function formatWritten(root: string, paths: readonly string[], dryRun: boolean): void {
  if (!dryRun) {
    formatFiles(root, paths);
  }
}

function pieceIdOf(raw: string): string {
  const id = raw.replace(/^pieces\//, '').replace(/\/+$/, '');

  try {
    validatePieceId(id);
  } catch (error) {
    throw usageError((error as Error).message);
  }

  return id;
}

function findContract(analysis: Analysis, id: string, ref: string): ContractInfo {
  const match = analysis.description.contracts.find((c) => c.exportName === ref || c.name === ref);
  const visible = match !== undefined && (match.scope === null || isWithin(id, match.scope));

  if (match === undefined || !visible) {
    throw usageError(
      `contract ${ref} is not ${match === undefined ? 'exported from contracts/*.ts or an ancestor contracts.ts' : `visible from ${id}`}`,
      `murmur new contract ${/^[A-Z][A-Za-z0-9]*$/.test(ref) ? ref : '<ClassName>'} --domain <file> --kind query`,
    );
  }

  return match;
}

function missingGroups(root: string, id: string): PlannedFile[] {
  const parts = id.split('/').slice(0, -1);

  return parts
    .map((_, i) => parts.slice(0, i + 1).join('/'))
    .filter((group) => !existsSync(join(root, 'pieces', group)))
    .map((group) => groupContextFile(root, group));
}

function report(ctx: CommandContext, result: WriteResult, next: readonly string[], dryRun: boolean): void {
  if (ctx.out.json) {
    ctx.out.emit({ kind: 'new', dryRun, ...result, next });

    return;
  }

  for (const path of result.created) {
    ctx.out.print(`${dryRun ? 'would create' : 'created'} ${path}`);
  }

  for (const path of result.skipped) {
    ctx.out.print(`skipped ${path} (exists)`);
  }

  for (const command of next) {
    ctx.out.print(`next: ${command}`);
  }
}

function classPieceFiles(ctx: CommandContext, root: string, id: string, analysis: Analysis): PlannedFile[] {
  const lookup = (ref: string) => findContract(analysis, id, ref);
  const request = {
    root,
    id,
    handles: listOption(ctx, 'handles').map(lookup),
    emits: listOption(ctx, 'emits').map(lookup),
    needs: listOption(ctx, 'needs'),
    config: parseKeyTypes(listOption(ctx, 'config'), 'config'),
    serves: listOption(ctx, 'serve'),
    edge: flag(ctx, 'edge'),
    idempotent: flag(ctx, 'idempotent'),
    summary: stringOption(ctx, 'summary') ?? null,
  };

  return planClassPieceFiles(classPiecePlan(analysis, request, lookup));
}

async function newPiece(ctx: CommandContext): Promise<number> {
  const root = requireRoot(ctx.cwd);
  const id = pieceIdOf(requirePositional(ctx, 1, 'piece path', USAGE));
  const force = flag(ctx, 'force');

  if (existsSync(join(root, 'pieces', id, 'piece.ts')) && !force) {
    throw new CliError(EXIT.findings, `pieces/${id}/piece.ts exists`, 'pass --force to overwrite');
  }

  const analysis = await analyze(root, ctx.env);
  const files = [...missingGroups(root, id), ...classPieceFiles(ctx, root, id, analysis)];
  const dryRun = flag(ctx, 'dry-run');
  const next = [`pnpm exec murmur ctx ${id}`, `pnpm exec murmur test ${id}`];
  const result = writeFiles(root, files, force, dryRun);
  formatWritten(root, result.created, dryRun);
  report(ctx, result, next, dryRun);

  return EXIT.ok;
}

const CLASS_KINDS: readonly ContractKind[] = ['query', 'command', 'event', 'guard'];

function className(raw: string): string {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(raw)) {
    throw usageError(`"${raw}": a contract class name is PascalCase, like GetTodo`);
  }

  return raw;
}

function wireOption(ctx: CommandContext): string | null {
  const name = stringOption(ctx, 'name');
  if (name === undefined) {
    return null;
  }

  try {
    validateName(name);
  } catch (error) {
    throw usageError((error as Error).message);
  }

  return name;
}

function classContractPlan(ctx: CommandContext, root: string): ClassContractPlan {
  const kind = choiceOption(ctx, 'kind', CLASS_KINDS, 'query');
  const domain = stringOption(ctx, 'domain');
  const output = stringOption(ctx, 'output') ?? null;

  if (domain === undefined) {
    throw usageError('--domain <file> is required', USAGE);
  }

  if (kind === 'guard' && output === null) {
    throw usageError(
      '--kind guard needs --output <Model> or --output key:type,… (written as a Model)',
      USAGE,
    );
  }

  return {
    root,
    className: className(requirePositional(ctx, 1, 'contract class name', USAGE)),
    domain,
    kind,
    input: parseKeyTypes(listOption(ctx, 'input'), 'input'),
    output,
    name: wireOption(ctx),
  };
}

function wireNameOf(plan: ClassContractPlan): string {
  return plan.name ?? `${plan.domain.replace(/\.ts$/, '').split('/').join('.')}.${plan.className}`;
}

interface ContractWrite {
  readonly file: string;
  readonly content: string;
  readonly exists: boolean;
  readonly appended: boolean;
  readonly exportName: string;
  readonly wireName: string;
}

function writeVerb(dryRun: boolean, appended: boolean): string {
  if (dryRun) {
    return 'would write';
  }

  return appended ? 'appended to' : 'created';
}

function writeContract(ctx: CommandContext, root: string, write: ContractWrite): number {
  const file = relative(root, write.file);
  if (write.exists) {
    throw new CliError(EXIT.findings, `${write.exportName} already exists in ${file}`);
  }

  const dryRun = flag(ctx, 'dry-run');
  if (!dryRun) {
    mkdirSync(dirname(write.file), { recursive: true });
    writeFileSync(write.file, write.content);
    formatFiles(root, [file]);
  }

  const { exportName, wireName, appended } = write;
  if (ctx.out.json) {
    ctx.out.emit({
      kind: 'new',
      dryRun,
      file,
      exportName,
      wireName,
      appended,
    });
  } else {
    ctx.out.print(`${writeVerb(dryRun, appended)} ${file} → ${exportName} (${wireName})`);
  }

  return EXIT.ok;
}

function newClassContract(ctx: CommandContext, root: string): number {
  const plan = classContractPlan(ctx, root);
  const scaffold = planClassContract(plan);

  return writeContract(ctx, root, { ...scaffold, exportName: plan.className, wireName: wireNameOf(plan) });
}

async function newContract(ctx: CommandContext): Promise<number> {
  return newClassContract(ctx, requireRoot(ctx.cwd));
}

const LIB_IMPORT = './lib/*.ts';

function libNext(root: string, name: string): string[] {
  const alias =
    readPackageImports(root)['#lib/*'] === LIB_IMPORT
      ? []
      : [`add "imports": { "#lib/*": "${LIB_IMPORT}" } to package.json`];

  return [...alias, `pnpm exec murmur ctx lib/${name}`, `pnpm exec murmur test lib/${name}.test.ts`];
}

async function newLib(ctx: CommandContext): Promise<number> {
  const root = requireRoot(ctx.cwd);
  const name = requirePositional(ctx, 1, 'lib module name', USAGE)
    .replace(/^lib\//, '')
    .replace(/\.ts$/, '');
  const problem = libNameProblem(name);
  const force = flag(ctx, 'force');

  if (problem !== null) {
    throw usageError(problem, USAGE);
  }

  if (existsSync(join(root, 'lib', `${name}.ts`)) && !force) {
    throw new CliError(EXIT.findings, `lib/${name}.ts exists`, 'pass --force to overwrite');
  }

  const dryRun = flag(ctx, 'dry-run');
  const result = writeFiles(root, planLib(root, name), force, dryRun);
  formatWritten(root, result.created, dryRun);
  report(ctx, result, libNext(root, name), dryRun);

  return EXIT.ok;
}

function registryOption(ctx: CommandContext): string | undefined {
  const registry = stringOption(ctx, 'registry');
  if (registry === undefined) {
    return undefined;
  }

  const protocol = URL.parse(registry)?.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw usageError(`--registry expects an http(s) URL, got ${registry}`, USAGE);
  }

  return registry;
}

function shellPath(path: string): string {
  return /^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

function appNextSteps(base: string, raw: string): string[] {
  const dir = isAbsolute(raw) ? resolve(raw) : relative(base, resolve(base, raw)) || '.';

  return [
    `cd ${shellPath(dir)}`,
    'pnpm install',
    'pnpm exec murmur new contract <Name> --domain <file> --kind query',
    'pnpm exec murmur new piece <path> --handles <Name>',
  ];
}

async function newApp(ctx: CommandContext): Promise<number> {
  const base = ctx.cwd ?? process.cwd();
  const raw = requirePositional(ctx, 1, 'app directory', USAGE);
  const dir = resolve(base, raw);

  if (stringOption(ctx, 'example') !== undefined) {
    throw usageError('--example templates ship with the example app (M10)');
  }

  choiceOption(ctx, 'transport', ['memory'] as const, 'memory');
  const registry = registryOption(ctx);

  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new CliError(EXIT.findings, `${dir} exists and is not empty`);
  }

  const result = writeFiles(dir, planApp(dir, registry), false, false);
  report(ctx, result, appNextSteps(base, raw), false);

  return EXIT.ok;
}

const KINDS: Readonly<Record<string, (ctx: CommandContext) => Promise<number>>> = {
  piece: newPiece,
  contract: newContract,
  lib: newLib,
  app: newApp,
};

async function run(ctx: CommandContext): Promise<number> {
  const kind = requirePositional(ctx, 0, 'what to create (piece, contract, lib, app)', USAGE);
  const handler = KINDS[kind];

  if (handler === undefined) {
    throw usageError(`murmur new ${kind}: expected piece, contract, lib or app`, USAGE);
  }

  return handler(ctx);
}

export const newCommand: Command = {
  usage: USAGE,
  options: {
    handles: { type: 'string' },
    serve: { type: 'string' },
    edge: { type: 'boolean' },
    idempotent: { type: 'boolean' },
    kind: { type: 'string' },
    input: { type: 'string' },
    output: { type: 'string' },
    name: { type: 'string' },
    emits: { type: 'string' },
    needs: { type: 'string' },
    config: { type: 'string' },
    summary: { type: 'string' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
    domain: { type: 'string' },
    example: { type: 'string' },
    transport: { type: 'string' },
    registry: { type: 'string' },
  },
  run,
};
