const RUN = 'pnpm exec murmur';

export interface CtxFlags {
  readonly budget: number | null;
  readonly withholdCode: boolean;
  readonly include: readonly string[];
}

export const MIGRATE_COMMAND = `${RUN} migrate`;

export function testCommand(id: string): string {
  return `${RUN} test pieces/${id}`;
}

export function checkCommand(id: string): string {
  return `${RUN} check pieces/${id}`;
}

export function fixCommand(id: string): string {
  return `${RUN} check --fix pieces/${id}`;
}

export function catalogCommand(contract: string): string {
  return `${RUN} catalog --contract ${contract}`;
}

export function ctxCommand(id: string, flags: CtxFlags): string {
  const budget = flags.budget === null ? '' : ` --budget ${flags.budget}`;
  const include = flags.include.length === 0 ? '' : ` --with ${flags.include.join(',')}`;

  return `${RUN} ctx pieces/${id}${include}${budget}${flags.withholdCode ? ' --withhold-code' : ''}`;
}
