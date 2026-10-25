import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Analysis } from './analyze.ts';
import { isRegenerationLeaf } from './discover.ts';
import { lanesOfPiece, type Lanes } from './lanes.ts';
import type { ConfigKeyInfo, PieceInfo } from './types.ts';

export type SnapshotWriter = 'catalog' | 'dev';

export interface SnapshotEntry extends Lanes {
  readonly className: string | null;
  readonly config: readonly ConfigKeyInfo[];
  readonly writer: SnapshotWriter;
  readonly writtenAt: string;
}

export interface LaneSnapshot {
  readonly version: 2;
  readonly pieces: Readonly<Record<string, SnapshotEntry>>;
}

const EMPTY: LaneSnapshot = { version: 2, pieces: {} };
const READABLE_VERSIONS = new Set([1, 2]);

export function laneSnapshotFile(root: string): string {
  return join(root, '.murmur', 'catalog-snapshot.json');
}

export function readLaneSnapshot(root: string): LaneSnapshot {
  try {
    const parsed = JSON.parse(readFileSync(laneSnapshotFile(root), 'utf8')) as {
      version?: number;
      pieces?: unknown;
    };

    if (
      !READABLE_VERSIONS.has(parsed.version ?? 0) ||
      typeof parsed.pieces !== 'object' ||
      parsed.pieces === null
    ) {
      return EMPTY;
    }

    return { version: 2, pieces: parsed.pieces as LaneSnapshot['pieces'] };
  } catch {
    return EMPTY;
  }
}

function entryOf(analysis: Analysis, info: PieceInfo, writer: SnapshotWriter, at: string): SnapshotEntry {
  return {
    ...lanesOfPiece(info, analysis.description.contracts),
    className: info.className ?? null,
    config: info.config,
    writer,
    writtenAt: at,
  };
}

function describedEntries(analysis: Analysis, writer: SnapshotWriter, at: string): [string, SnapshotEntry][] {
  return analysis.description.pieces.flatMap((info): [string, SnapshotEntry][] => {
    if (!info.hasPieceClass || analysis.repo.folders.get(info.id)?.kind !== 'piece') {
      return [];
    }

    return [[info.id, entryOf(analysis, info, writer, at)]];
  });
}

function leafEntries(analysis: Analysis, previous: LaneSnapshot): [string, SnapshotEntry][] {
  return Object.entries(previous.pieces).filter(([id]) => {
    const node = analysis.repo.folders.get(id);

    return node !== undefined && isRegenerationLeaf(node);
  });
}

export function mergeLaneSnapshot(
  previous: LaneSnapshot,
  analysis: Analysis,
  writer: SnapshotWriter,
  at: string,
): LaneSnapshot {
  const described = describedEntries(analysis, writer, at);
  const pieces = Object.fromEntries([...leafEntries(analysis, previous), ...described]);

  return { version: 2, pieces };
}

export function writeLaneSnapshot(
  analysis: Analysis,
  writer: SnapshotWriter,
  at = new Date().toISOString(),
): void {
  const { root } = analysis.repo;
  const file = laneSnapshotFile(root);
  const next = mergeLaneSnapshot(readLaneSnapshot(root), analysis, writer, at);
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;

  try {
    mkdirSync(join(root, '.murmur'), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temp, file);
  } catch {}
}
