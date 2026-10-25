import { isSettledLifecycleRun, type RunContext } from 'murmur';

import { current } from '../context.ts';

function holderOf(run: RunContext | undefined): unknown {
  return run?.deliveryId ?? run;
}

export function ambientHolder(): unknown {
  const run = current();
  if (run === undefined || isSettledLifecycleRun(run)) {
    return undefined;
  }

  return holderOf(run);
}
