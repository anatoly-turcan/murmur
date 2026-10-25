import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

import type { Command, CommandContext } from './command.ts';
import { catalogCommand } from './commands/catalog.ts';
import { checkCommand } from './commands/check.ts';
import { ctxCommand } from './commands/ctx.ts';
import { devCommand } from './commands/dev.ts';
import { doctorCommand } from './commands/doctor.ts';
import { emitCommand } from './commands/emit.ts';
import { migrateCommand } from './commands/migrate.ts';
import { newCommand } from './commands/new.ts';
import { startCommand } from './commands/start.ts';
import { tailCommand } from './commands/tail.ts';
import { testCommand } from './commands/test.ts';
import { traceCommand } from './commands/trace.ts';
import { CliError, EXIT } from './errors.ts';
import { createOutput, type Output } from './output.ts';
import { cliVersion } from './version.ts';

const COMMANDS: Readonly<Record<string, Command>> = {
  dev: devCommand,
  start: startCommand,
  migrate: migrateCommand,
  tail: tailCommand,
  trace: traceCommand,
  emit: emitCommand,
  catalog: catalogCommand,
  ctx: ctxCommand,
  check: checkCommand,
  new: newCommand,
  test: testCommand,
  doctor: doctorCommand,
};

const GLOBAL_OPTIONS: ParseArgsOptionsConfig = {
  cwd: { type: 'string' },
  json: { type: 'boolean' },
  color: { type: 'boolean', default: true },
  'env-file': { type: 'string', multiple: true },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
};

const VALUE_FLAGS = new Set(['--cwd', '--env-file']);

function usage(): string {
  const lines = Object.entries(COMMANDS).map(([name, command]) => `  ${command.usage || name}`);

  return [
    'murmur <command> [args] [flags]',
    '',
    ...lines,
    '',
    'global: --cwd <dir>  --json  --no-color  --env-file <path>  -q/--quiet  -h/--help  -V/--version',
  ].join('\n');
}

function splitCommand(argv: readonly string[]): { name: string | undefined; rest: string[] } {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (VALUE_FLAGS.has(arg)) {
      i++;
    } else if (!arg.startsWith('-')) {
      return { name: arg, rest: argv.toSpliced(i, 1) };
    }
  }

  return { name: undefined, rest: [...argv] };
}

function assertNode(): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 26) {
    throw new CliError(
      EXIT.internal,
      `murmur needs Node >= 26 (running ${process.versions.node})`,
      'nvm install 26 && nvm use 26',
    );
  }
}

function exitCodeOf(error: unknown): number {
  if (error instanceof CliError) {
    return error.code;
  }

  const isUsage =
    error instanceof TypeError && String(Reflect.get(error, 'code')).startsWith('ERR_PARSE_ARGS');

  return isUsage ? EXIT.usage : EXIT.internal;
}

function report(out: Output, error: unknown): number {
  const code = exitCodeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof CliError ? error.hint : undefined;

  if (out.json) {
    out.emit({ kind: 'error', code, message, ...(hint === undefined ? {} : { hint }) });
  } else {
    out.warn(`murmur: ${message}${hint === undefined ? '' : `\n  hint: ${hint}`}`);
  }

  return code;
}

function parse(command: Command | undefined, rest: string[]) {
  return parseArgs({
    args: rest,
    options: { ...GLOBAL_OPTIONS, ...command?.options },
    allowPositionals: true,
    allowNegative: true,
    strict: true,
  });
}

async function dispatch(argv: readonly string[]): Promise<number> {
  const { name, rest } = splitCommand(argv);
  const command = name === undefined ? undefined : COMMANDS[name];
  const { values, positionals } = parse(command, rest);
  const output = createOutput({
    json: values['json'] === true,
    quiet: values['quiet'] === true,
    color: values['color'] !== false,
  });

  if (values['version'] === true) {
    output.print(cliVersion());

    return EXIT.ok;
  }

  if (values['help'] === true || name === undefined) {
    process.stdout.write(`${usage()}\n`);

    return name === undefined && values['help'] !== true ? EXIT.usage : EXIT.ok;
  }

  if (command === undefined) {
    throw new CliError(EXIT.usage, `unknown command "${name}"`, usage());
  }

  const ctx: CommandContext = {
    positionals,
    values,
    out: output,
    cwd: typeof values['cwd'] === 'string' ? values['cwd'] : undefined,
    env: process.env,
  };

  return command.run(ctx);
}

export async function main(argv: readonly string[]): Promise<number> {
  const fallback = createOutput({ json: argv.includes('--json'), quiet: false, color: false });

  try {
    assertNode();

    return await dispatch(argv);
  } catch (error) {
    return report(fallback, error);
  }
}

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    process.exit(process.exitCode ?? 0);
  }

  throw error;
});
process.exitCode = await main(process.argv.slice(2));
