import { Command, type CommandClass } from 'murmur';
import type { z } from 'zod';

export function Cmd(input: Record<string, z.ZodType>, output: z.ZodType): CommandClass {
  return Command(input, output);
}
