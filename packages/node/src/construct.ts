import {
  constructPiece,
  MurmurError,
  type Bus,
  type Capability,
  type Clock,
  type Ids,
  type PieceApi,
  type PieceClass,
} from 'murmur';

import type { LogFactory } from './capabilities/log.ts';
import { current } from './context.ts';
import type { BootError, LoadedPiece } from './types.ts';

export interface ConstructDeps {
  readonly bus: Bus;
  readonly logs: LogFactory;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly capabilities: ReadonlyMap<string, unknown>;
  readonly skipped: ReadonlyMap<string, string>;
  readonly instances: Map<string, object>;
}

function notStarted(deps: ConstructDeps, token: Capability, field: string): MurmurError {
  const reason = deps.skipped.get(token.name);
  const why = reason === undefined ? '' : ` (${reason})`;

  return new MurmurError(`needs.${field}: capability ${token.name} is not started${why}`, {
    retryable: false,
  });
}

function resolveNeed(deps: ConstructDeps, token: Capability, field: string): unknown {
  if (!deps.capabilities.has(token.name)) {
    throw notStarted(deps, token, field);
  }

  return deps.capabilities.get(token.name);
}

export function pieceApi(piece: LoadedPiece, deps: ConstructDeps): PieceApi {
  const port = deps.bus.portFor(piece.name);

  return {
    piece: piece.name,
    log: deps.logs.forCurrent(piece.name, current),
    clock: deps.clock,
    ids: deps.ids,
    config: piece.config,
    resolve: (token, field) => resolveNeed(deps, token, field),
    emit: port.emit,
    request: port.request,
  };
}

function constructionError(piece: LoadedPiece, pieceClass: PieceClass, error: unknown): BootError {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  return {
    phase: 'construct',
    piece: piece.name,
    file: piece.file,
    message: `${pieceClass.name} could not be constructed: ${reason}`,
  };
}

function constructOne(piece: LoadedPiece, deps: ConstructDeps): BootError[] {
  const { pieceClass } = piece.definition;

  try {
    deps.instances.set(piece.name, constructPiece(pieceClass, pieceApi(piece, deps)));

    return [];
  } catch (error) {
    return [constructionError(piece, pieceClass, error)];
  }
}

export function constructPieces(pieces: readonly LoadedPiece[], deps: ConstructDeps): BootError[] {
  return pieces.flatMap((piece) => constructOne(piece, deps));
}

export function instanceOf(instances: ReadonlyMap<string, object>, name: string): object {
  const instance = instances.get(name);
  if (instance === undefined) {
    throw new MurmurError(`piece ${name} is not constructed yet`, { retryable: false });
  }

  return instance;
}
