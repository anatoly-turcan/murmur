import type { ParseArgsOptionsConfig } from 'node:util';

import { usageError } from './errors.ts';
import type { Output } from './output.ts';

export type OptionValue = string | boolean | (string | boolean)[] | undefined;

export interface CommandContext {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, OptionValue>>;
  readonly out: Output;
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface Command {
  readonly usage: string;
  readonly options: ParseArgsOptionsConfig;
  run(ctx: CommandContext): Promise<number>;
}

export function stringOption(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.values[name];

  return typeof value === 'string' ? value : undefined;
}

export function flag(ctx: CommandContext, name: string): boolean {
  return ctx.values[name] === true;
}

export function listOption(ctx: CommandContext, name: string): string[] {
  const value = stringOption(ctx, name);

  return value === undefined
    ? []
    : value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
}

export function intOption(ctx: CommandContext, name: string): number | undefined {
  const value = stringOption(ctx, name);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw usageError(`--${name} must be a non-negative integer`);
  }

  return parsed;
}

export function choiceOption<T extends string>(
  ctx: CommandContext,
  name: string,
  choices: readonly T[],
  fallback: T,
): T {
  const value = stringOption(ctx, name) ?? fallback;
  if (!choices.includes(value as T)) {
    throw usageError(`--${name} must be one of ${choices.join(', ')}`);
  }

  return value as T;
}

export function requirePositional(ctx: CommandContext, index: number, what: string, usage: string): string {
  const value = ctx.positionals[index];
  if (value === undefined) {
    throw usageError(`missing ${what}`, usage);
  }

  return value;
}
