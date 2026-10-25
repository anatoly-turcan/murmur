import type { TraceSummary } from '../../store/selectors.ts';

export function resolveTraceId(input: string, traces: TraceSummary[]): string {
  const trimmed = input.trim();
  const exact = traces.find((t) => t.traceId === trimmed);

  if (exact) {
    return exact.traceId;
  }

  const [only, ...others] = traces.filter((t) => t.traceId.startsWith(trimmed));

  return only !== undefined && others.length === 0 ? only.traceId : trimmed;
}

export function groupByRoot(traces: TraceSummary[]): [string, TraceSummary[]][] {
  return [...Map.groupBy(traces, (t) => t.root.envelope.name).entries()];
}
