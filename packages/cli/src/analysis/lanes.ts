import type { ContractInfo, PieceInfo } from './types.ts';

export const LANES = ['needs', 'listens', 'emits', 'requests', 'serves'] as const;

export type LaneName = (typeof LANES)[number];

export type Lanes = Readonly<Record<LaneName, readonly string[]>>;

export type PartialLanes = Partial<Lanes>;

export type LaneSource = 'catalog' | 'catalog-snapshot' | 'context.md' | 'tests' | 'none';

export interface LaneValue {
  readonly values: readonly string[];
  readonly source: LaneSource;
}

export type ResolvedLanes = Readonly<Record<LaneName, LaneValue>>;

export interface LaneCandidate {
  readonly source: LaneSource;
  readonly lanes: PartialLanes;
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function lanesOfPiece(info: PieceInfo, contracts: readonly ContractInfo[]): Lanes {
  const hasReply = (name: string) => contracts.find((c) => c.name === name)?.hasReply ?? false;

  return {
    needs: unique(info.needFields ?? info.needs),
    listens: unique(info.handlers.map((h) => h.contract)),
    emits: unique(info.emits.filter((name) => !hasReply(name))),
    requests: unique([...(info.requests ?? []), ...info.emits.filter(hasReply)]),
    serves: unique((info.serves ?? []).map((serve) => serve.key)),
  };
}

function resolveLane(lane: LaneName, candidates: readonly LaneCandidate[]): LaneValue {
  for (const candidate of candidates) {
    const values = candidate.lanes[lane];
    if (values !== undefined) {
      return { values, source: candidate.source };
    }
  }

  return { values: [], source: 'none' };
}

function capOf(need: string): string {
  return need.slice(need.indexOf('=') + 1);
}

function loneField(lane: LaneValue, candidates: readonly LaneCandidate[]): string | undefined {
  const fields = candidates
    .filter((c) => c.source === 'tests')
    .flatMap((c) => c.lanes.needs ?? [])
    .filter((need) => !need.includes('=') && !lane.values.includes(need));

  return fields.length === 1 && lane.values.length === 1 ? fields[0] : undefined;
}

function withFieldNames(lane: LaneValue, candidates: readonly LaneCandidate[]): LaneValue {
  const named = candidates.flatMap((c) => c.lanes.needs ?? []).filter((need) => need.includes('='));
  const field = loneField(lane, candidates);
  const values = lane.values.map((need) => {
    if (need.includes('=')) {
      return need;
    }

    const match = named.find((candidate) => capOf(candidate) === need);

    return match ?? (field === undefined ? need : `${field}=${need}`);
  });

  return { values, source: lane.source };
}

export function resolveLanes(candidates: readonly LaneCandidate[]): ResolvedLanes {
  return {
    needs: withFieldNames(resolveLane('needs', candidates), candidates),
    listens: resolveLane('listens', candidates),
    emits: resolveLane('emits', candidates),
    requests: resolveLane('requests', candidates),
    serves: resolveLane('serves', candidates),
  };
}

export function contractLanes(lanes: ResolvedLanes): string[] {
  return unique([...lanes.listens.values, ...lanes.emits.values, ...lanes.requests.values]);
}
