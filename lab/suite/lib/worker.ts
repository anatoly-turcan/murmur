import { execSync } from 'node:child_process';
import { env } from './env.ts';

export const workerControlSkip: string | false =
  env.workerStopCmd && env.workerStartCmd ? false : 'needs SUITE_WORKER_STOP_CMD and SUITE_WORKER_START_CMD';

function run(cmd: string): void {
  execSync(cmd, { stdio: 'inherit', shell: '/bin/bash', timeout: 30_000 });
}

export function killWorkers(): void {
  run(env.workerStopCmd);
}

export function startWorkers(): void {
  run(env.workerStartCmd);
}
