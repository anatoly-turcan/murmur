import { AsyncLocalStorage } from 'node:async_hooks';

import type { RunContext } from 'murmur';

export const runContext = new AsyncLocalStorage<RunContext>();

export function current(): RunContext | undefined {
  return runContext.getStore();
}
