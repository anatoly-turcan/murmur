import type { RunContext } from 'murmur';

import { runContext } from '../context.ts';

export function runInContext<T>(context: Partial<RunContext>, fn: () => T): T {
  const run: RunContext = {
    traceId: 'trace_test',
    hop: 0,
    piece: 'test',
    deliveryId: crypto.randomUUID(),
    attempt: 1,
    signal: new AbortController().signal,
    internal: false,
    ...context,
  };

  return runContext.run(run, fn);
}
