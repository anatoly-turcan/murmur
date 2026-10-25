import type { BusContract } from 'murmur';

import type { BootError, BootWarning } from '../types.ts';
import type { PieceDefinition } from './class-piece.ts';

export interface PieceCandidate {
  readonly id: string;
  readonly file: string;
  readonly dir: string;
  title: string;
  summary: string | null;
  readonly parent: string | null;
  readonly depth: number;
  definition: PieceDefinition | undefined;
  readonly errors: BootError[];
  readonly warnings: BootWarning[];
}

export interface ValidPiece extends PieceCandidate {
  definition: PieceDefinition;
}

export interface ContractSource {
  readonly contract: BusContract;
  readonly file: string;
  readonly visibility: 'public' | 'internal';
  readonly scope: string | null;
}

export function isValid(candidate: PieceCandidate): candidate is ValidPiece {
  return candidate.definition !== undefined;
}

export function usedContracts(piece: ValidPiece): BusContract[] {
  const { emits, handlers } = piece.definition;

  return [...emits, ...handlers.map((h) => h.contract)];
}

export function inScope(id: string, scope: string): boolean {
  return id === scope || id.startsWith(`${scope}/`);
}
