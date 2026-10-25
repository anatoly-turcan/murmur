import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { EXIT } from './errors.ts';

const FORWARDED = ['SIGINT', 'SIGTERM'] as const;

const INSPECT_PORT = '--inspect-port';

function forwardSignals(child: ChildProcess): void {
  for (const signal of FORWARDED) {
    process.on(signal, () => child.kill(signal));
  }
}

function isInspectorArg(arg: string, previous: string | undefined): boolean {
  return arg.startsWith('--inspect') || previous === INSPECT_PORT;
}

export function forwardedExecArgv(execArgv: readonly string[]): string[] {
  return execArgv.filter((arg, index) => !isInspectorArg(arg, execArgv[index - 1]));
}

export async function runChild(args: readonly string[], cwd?: string): Promise<number> {
  const child = spawn(process.execPath, args, { stdio: 'inherit', ...(cwd === undefined ? {} : { cwd }) });

  forwardSignals(child);

  const [code] = (await once(child, 'exit')) as [number | null];

  return code ?? EXIT.interrupted;
}

export function relaunchWith(execArgv: readonly string[]): Promise<number> {
  return runChild([...forwardedExecArgv(process.execArgv), ...execArgv, ...process.argv.slice(1)]);
}
