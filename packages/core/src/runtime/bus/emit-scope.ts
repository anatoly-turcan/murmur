import type { BusContract } from './contracts.ts';
import { publishEvent, assertDeclared } from './publish.ts';
import type { EmitScope } from './state.ts';

export type { EmitScope } from './state.ts';

export function emitFrom(scope: EmitScope, contract: BusContract, payload: unknown): Promise<void> {
  const { state, piece, run } = scope;
  assertDeclared(piece.name, piece.declared, contract);
  const late = scope.isLate();
  const work = publishEvent(state, contract, payload, { parent: run, source: piece.name, late });
  work.catch(() => {});

  if (!late) {
    scope.emits.push(work);
  }

  return work;
}

export async function drainEmits(emits: readonly Promise<void>[], from = 0): Promise<void> {
  if (from >= emits.length) {
    return;
  }

  const until = emits.length;
  await Promise.all(emits.slice(from, until));
  await drainEmits(emits, until);
}
