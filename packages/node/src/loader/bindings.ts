import { bindingConflicts, describePiece, routeShadows, type ServedBinding } from 'murmur';

import type { BootError, CatalogRoute } from '../types.ts';
import type { ValidPiece } from './candidate.ts';

function servedBy(piece: ValidPiece): ServedBinding[] {
  return describePiece(piece.definition.pieceClass).serves.map((serve) => ({
    piece: piece.id,
    binding: serve.binding,
  }));
}

export function servedBindings(pieces: readonly ValidPiece[]): ServedBinding[] {
  return pieces.flatMap(servedBy);
}

export interface RouteProblem {
  readonly code: 'binding-conflict' | 'route-shadowed';
  readonly piece: string;
  readonly message: string;
}

export function routeProblems(served: readonly ServedBinding[]): RouteProblem[] {
  const conflicts = bindingConflicts(served)
    .filter((conflict) => conflict.first.piece !== conflict.second.piece)
    .map((conflict) => ({
      code: 'binding-conflict' as const,
      piece: conflict.second.piece,
      message: conflict.message,
    }));
  const shadows = routeShadows(served).map((shadow) => ({
    code: 'route-shadowed' as const,
    piece: shadow.first.piece,
    message: shadow.message,
  }));

  return [...conflicts, ...shadows];
}

export function bindingErrors(served: readonly ServedBinding[]): BootError[] {
  return routeProblems(served).map((problem) => ({ phase: 'subscribe', ...problem }));
}

export function catalogRoutes(served: readonly ServedBinding[]): CatalogRoute[] {
  return served.map(({ piece, binding }) => ({
    transport: binding.transport,
    key: binding.key,
    piece,
    guards: (binding.guards ?? []).map((guard) => guard.wireName),
  }));
}
