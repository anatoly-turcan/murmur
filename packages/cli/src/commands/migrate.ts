import { migrate, type MigrateResult } from '@murmur/node';

import type { Command, CommandContext } from '../command.ts';
import { withEnvFiles } from '../dev/env-files.ts';
import { envFiles } from '../dev/options.ts';
import { CliError, EXIT } from '../errors.ts';
import { requireRoot } from '../root.ts';

function summary(result: MigrateResult): string {
  if (result.applied.length === 0) {
    return `up to date (${result.files.length} migrations)`;
  }

  return `applied ${result.applied.length}: ${result.applied.join(', ')}`;
}

async function applied(ctx: CommandContext, root: string): Promise<MigrateResult> {
  try {
    return await migrate(root, withEnvFiles(root, envFiles(ctx), ctx.env));
  } catch (error) {
    throw new CliError(EXIT.boot, error instanceof Error ? error.message : String(error));
  }
}

async function run(ctx: CommandContext): Promise<number> {
  const root = requireRoot(ctx.cwd);
  const result = await applied(ctx, root);

  if (ctx.out.json) {
    ctx.out.emit({ kind: 'migrate', ...result });

    return EXIT.ok;
  }

  for (const source of result.unmatched) {
    ctx.out.warn(`sqlite migrations: ${source} matches no file`);
  }

  ctx.out.print(`migrate  ${result.path}  ${summary(result)}`);

  return EXIT.ok;
}

export const migrateCommand: Command = {
  usage: 'migrate',
  options: {},
  run,
};
