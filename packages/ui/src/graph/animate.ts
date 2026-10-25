import type { GraphEdge } from './edges.ts';

export const PULSE_MS = 400;
export const PULSE_INTERVAL_MS = 100;

export interface PulseLimiter {
  admit: (edgeId: string, now: number) => boolean;
  suppressed: (edgeId: string) => number;
}

export function createPulseLimiter(intervalMs = PULSE_INTERVAL_MS): PulseLimiter {
  const last = new Map<string, number>();
  const skipped = new Map<string, number>();

  return {
    admit: (edgeId, now) => {
      const at = last.get(edgeId);
      if (at !== undefined && now - at < intervalMs) {
        skipped.set(edgeId, (skipped.get(edgeId) ?? 0) + 1);

        return false;
      }

      last.set(edgeId, now);
      skipped.set(edgeId, 0);

      return true;
    },
    suppressed: (edgeId) => skipped.get(edgeId) ?? 0,
  };
}

export interface DeliveryHint {
  name: string;
  source: string | undefined;
  handlers: string[];
}

export function edgesForDelivery(
  edges: GraphEdge[],
  repOf: (piece: string) => string | undefined,
  hint: DeliveryHint,
): GraphEdge[] {
  if (hint.source) {
    const from = repOf(hint.source);

    return edges.filter((e) => e.contract === hint.name && e.from === from && !e.warning);
  }

  const targets = new Set(hint.handlers.flatMap((h) => repOf(h) ?? []));

  return edges.filter((e) => e.from.startsWith('ingress:') && targets.has(e.to));
}

export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, (x2 - x1) / 2);

  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
