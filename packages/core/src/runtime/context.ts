import type { RunContext } from '../model/context.ts';

export interface ContextStorage<T> {
  run<R>(store: T, fn: () => R): R;
  getStore(): T | undefined;
}

export function current(context: ContextStorage<RunContext>): RunContext | undefined {
  return context.getStore();
}

const settledLifecycleRuns = new WeakSet<RunContext>();

export function markLifecycleSettled(run: RunContext): void {
  settledLifecycleRuns.add(run);
}

export function isSettledLifecycleRun(run: RunContext): boolean {
  return settledLifecycleRuns.has(run);
}
