import { join } from 'node:path';

import type { Analysis } from './analyze.ts';
import { contextLanes } from './context-lanes.ts';
import { isRegenerationLeaf } from './discover.ts';
import { readLaneSnapshot, type SnapshotEntry } from './lane-snapshot.ts';
import { lanesOfPiece, resolveLanes, type LaneCandidate, type ResolvedLanes } from './lanes.ts';
import { readSource } from './source-checks.ts';
import { testLanes } from './test-lanes.ts';
import type { ConfigKeyInfo, FolderNode, PieceInfo } from './types.ts';

export type RegenerationReason = 'withheld' | 'absent';

export interface Regeneration {
  readonly reason: RegenerationReason;
  readonly lanes: ResolvedLanes;
  readonly config: readonly ConfigKeyInfo[];
  readonly snapshot: Pick<SnapshotEntry, 'writer' | 'writtenAt'> | null;
}

export interface RegenerationInput {
  readonly analysis: Analysis;
  readonly node: FolderNode;
  readonly info: PieceInfo | undefined;
  readonly ownContext: string | null;
  readonly withholdCode: boolean;
}

export function regenerationReason(node: FolderNode, withholdCode: boolean): RegenerationReason | null {
  if (node.kind === 'piece') {
    return withholdCode ? 'withheld' : null;
  }

  return isRegenerationLeaf(node) ? 'absent' : null;
}

function testCandidate(analysis: Analysis, node: FolderNode): LaneCandidate[] {
  const tests = node.files.filter((path) => path.endsWith('.test.ts'));
  if (tests.length === 0) {
    return [];
  }

  const lanes = testLanes({
    contracts: analysis.description.contracts,
    capabilities: analysis.description.capabilities.map((c) => c.name),
    root: analysis.repo.root,
    dir: node.dir,
    sources: tests.map((path) => readSource(join(node.dir, path)) ?? ''),
  });

  return [{ source: 'tests', lanes }];
}

function candidates(input: RegenerationInput, snapshot: SnapshotEntry | undefined): LaneCandidate[] {
  const { analysis, info } = input;

  return [
    ...(info?.hasPieceClass === true
      ? [{ source: 'catalog' as const, lanes: lanesOfPiece(info, analysis.description.contracts) }]
      : []),
    ...(snapshot === undefined ? [] : [{ source: 'catalog-snapshot' as const, lanes: snapshot }]),
    { source: 'context.md', lanes: contextLanes(input.ownContext) },
    ...testCandidate(analysis, input.node),
  ];
}

export function regenerationOf(input: RegenerationInput): Regeneration | null {
  const reason = regenerationReason(input.node, input.withholdCode);
  if (reason === null) {
    return null;
  }

  const snapshot = readLaneSnapshot(input.analysis.repo.root).pieces[input.node.id];

  return {
    reason,
    lanes: resolveLanes(candidates(input, snapshot)),
    config: input.info?.config ?? snapshot?.config ?? [],
    snapshot: snapshot === undefined ? null : { writer: snapshot.writer, writtenAt: snapshot.writtenAt },
  };
}
