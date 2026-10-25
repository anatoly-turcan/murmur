import { resolve } from 'node:path';

import { BootFailedError, createRuntime, formatReport, type Runtime } from '@murmur/node';

import { registerAppLoader } from '../app-exec-argv.ts';
import type { Command, CommandContext } from '../command.ts';
import { existingEnvFiles } from '../dev/env-files.ts';
import { envFiles, processArgument } from '../dev/options.ts';
import { CliError, EXIT } from '../errors.ts';
import { requireRoot } from '../root.ts';

function untilStopped(): Promise<string> {
  const stopped = Promise.withResolvers<string>();

  process.on('SIGINT', () => stopped.resolve('SIGINT'));
  process.on('SIGTERM', () => stopped.resolve('SIGTERM'));

  return stopped.promise;
}

function keepAliveUntil(done: Promise<unknown>): void {
  const timer = setInterval(() => {}, 2 ** 30);
  void done.finally(() => clearInterval(timer));
}

async function boot(root: string, name: string | undefined): Promise<Runtime> {
  try {
    const runtime = await createRuntime({
      root,
      mode: 'prod',
      signals: false,
      ...(name === undefined ? {} : { process: name }),
    });

    await runtime.start();

    return runtime;
  } catch (error) {
    if (error instanceof BootFailedError) {
      throw new CliError(EXIT.boot, formatReport(error.report));
    }

    throw error;
  }
}

function loadEnvFiles(root: string, files: readonly string[]): void {
  for (const file of existingEnvFiles(root, files)) {
    process.loadEnvFile(resolve(root, file));
  }
}

async function run(ctx: CommandContext): Promise<number> {
  const root = requireRoot(ctx.cwd);
  await registerAppLoader(root);
  loadEnvFiles(root, envFiles(ctx));
  const name = processArgument(ctx);
  const stopped = untilStopped();
  const runtime = await boot(root, name);
  keepAliveUntil(stopped);
  const label = name === undefined ? '' : `  process=${name}`;
  ctx.out.info(`murmur start  pieces=${runtime.pieces.length}  pid=${process.pid}${label}`);
  await runtime.stop(await stopped);

  return EXIT.ok;
}

export const startCommand: Command = {
  usage: 'start [<process>]',
  options: {},
  run,
};
