import type { Analysis } from '../analysis/analyze.ts';

export interface AnalysisCache {
  refresh(): void;
  cached(): Analysis | null;
  latest(): Promise<Analysis>;
}

export function createAnalysisCache(load: () => Promise<Analysis>): AnalysisCache {
  let generation = 0;
  let resolved: { readonly generation: number; readonly analysis: Analysis } | null = null;
  const start = (): Promise<Analysis> => {
    const current = ++generation;
    const next = load();
    next.then(
      (analysis) => {
        if (resolved === null || current > resolved.generation) {
          resolved = { generation: current, analysis };
        }

        return analysis;
      },
      () => null,
    );

    return next;
  };
  let pending = start();
  const refresh = () => {
    pending = start();
  };

  return {
    refresh,
    cached: () => resolved?.analysis ?? null,
    latest: () =>
      pending.catch((error: unknown) => {
        if (resolved === null) {
          throw error;
        }

        return resolved.analysis;
      }),
  };
}
