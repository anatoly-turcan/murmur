import { resolve } from 'node:path';

import { intOption, stringOption, type CommandContext } from '../command.ts';
import { usageError } from '../errors.ts';
import { parseSize, type PayloadPolicy } from './payload.ts';

const DEFAULT_ENV_FILES = ['.env', '.env.local'];

export function envFiles(ctx: CommandContext): string[] {
  const value = ctx.values['env-file'];
  const files = Array.isArray(value) ? value.filter((file) => typeof file === 'string') : [];

  return files.length === 0 ? DEFAULT_ENV_FILES : files;
}

export function processArgument(ctx: CommandContext): string | undefined {
  if (ctx.positionals.length > 1) {
    throw usageError(
      `murmur start takes one process name, got ${ctx.positionals.join(' ')}`,
      'murmur start <process> (a key of defineApp({ processes }))',
    );
  }

  return ctx.positionals[0];
}

export function processOption(ctx: CommandContext): string | undefined {
  return stringOption(ctx, 'process');
}

export function payloadPolicy(ctx: CommandContext): PayloadPolicy {
  const cap = parseSize(stringOption(ctx, 'payload-cap') ?? '16kb');
  if (cap === null) {
    throw usageError('--payload-cap must be a size like 16kb');
  }

  return { redact: ctx.values['redact'] === true, capBytes: cap };
}

export function traceDir(ctx: CommandContext, root: string): string {
  return resolve(root, stringOption(ctx, 'trace-dir') ?? '.murmur/traces');
}

export function portOption(ctx: CommandContext): number {
  const port = intOption(ctx, 'port') ?? 4242;
  if (port > 65_535) {
    throw usageError('--port must be 0-65535');
  }

  return port;
}
