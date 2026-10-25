import {
  classPieceRuntime,
  describePiece,
  isPieceClass,
  MurmurError,
  type BusContract,
  type Capability,
  type PieceClass,
  type PieceHandlerEntry,
  type PiecePolicy,
  type Schema,
} from 'murmur';

export interface PieceDefinition {
  readonly pieceClass: PieceClass;
  readonly config: Readonly<Record<string, Schema>>;
  readonly needs: readonly string[];
  readonly emits: readonly BusContract[];
  readonly handlers: readonly PieceHandlerEntry[];
  readonly policy: PiecePolicy;
}

export type PieceExport =
  | { readonly ok: true; readonly definition: PieceDefinition }
  | { readonly ok: false; readonly message: string };

const notConstructed = (): object => {
  throw new MurmurError(
    'a piece definition lists contracts only: dispatch goes through the runtime built after construction',
    { retryable: false },
  );
};

export function classDefinition(id: string, piece: PieceClass): PieceDefinition {
  const runtime = classPieceRuntime({ name: id, piece, instance: notConstructed });

  return Object.freeze({
    pieceClass: piece,
    config: (piece.declaration.config ?? {}) as Readonly<Record<string, Schema>>,
    needs: runtime.needs ?? [],
    emits: runtime.emits,
    handlers: runtime.handlers,
    policy: runtime.policy,
  });
}

export function neededTokens(definition: PieceDefinition): Capability[] {
  return Object.values(definition.pieceClass.declaration.needs ?? {});
}

export function hasSchedules(definition: PieceDefinition): boolean {
  return describePiece(definition.pieceClass).handlers.some((entry) => entry.every !== undefined);
}

export function servedTokens(definition: PieceDefinition): Capability[] {
  const tokens = describePiece(definition.pieceClass).serves.flatMap(
    (serve) => serve.binding.capability ?? [],
  );

  return [...new Set(tokens)];
}

function pieceClassesOf(module: Record<string, unknown>): PieceClass[] {
  const named = Object.entries(module).filter(([key]) => key !== 'default');

  return [...new Set(named.map(([, value]) => value).filter(isPieceClass))];
}

function exportMessage(classes: readonly PieceClass[]): string {
  if (classes.length === 0) {
    return 'piece.ts must export one piece class (export class Todos extends Piece({ … }))';
  }

  return `piece.ts exports ${classes.length} piece classes (${classes.map((c) => c.name).join(', ')}): export exactly one`;
}

function described(id: string, piece: PieceClass): PieceExport {
  try {
    describePiece(piece);

    return { ok: true, definition: classDefinition(id, piece) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function classPieceExport(id: string, module: Record<string, unknown>): PieceExport {
  const classes = pieceClassesOf(module);
  const [only] = classes;

  if (classes.length !== 1 || only === undefined) {
    return { ok: false, message: exportMessage(classes) };
  }

  return described(id, only);
}
