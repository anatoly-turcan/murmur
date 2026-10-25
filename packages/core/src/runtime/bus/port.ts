import type { RunContext } from '../../model/context.ts';
import type { ContractClass } from '../../model/contract-class.ts';
import type { RequestOptions } from '../../model/policy.ts';
import { busContractOf, type BusContract } from './contracts.ts';
import { emitFrom } from './emit-scope.ts';
import { sendRequest } from './request.ts';
import { registeredPiece, type BusState, type EmitScope } from './state.ts';

export interface PiecePort {
  emit(contract: ContractClass, payload: unknown): Promise<void>;
  request(contract: ContractClass, input: unknown, options?: RequestOptions): Promise<unknown>;
}

function ownScope(state: BusState, piece: string): EmitScope | undefined {
  const run = state.context.getStore();
  if (run === undefined) {
    return undefined;
  }

  const scope = state.scopes.get(run);
  if (scope?.piece.name !== piece) {
    return undefined;
  }

  return scope;
}

function backgroundScope(state: BusState, piece: string, contract: BusContract): EmitScope {
  const entry = registeredPiece(state, piece);
  const run: RunContext = {
    piece,
    traceId: state.ids.uuid(),
    hop: -1,
    signal: state.closing.signal,
    internal: false,
  };
  const scope: EmitScope = { state, piece: entry, run, emits: [], isLate: () => false };
  state.scopes.set(run, scope);
  state.sys(
    'emit.background',
    { piece, contract: contract.name },
    { traceId: run.traceId, hop: 0, source: 'background' },
  );

  return scope;
}

function scopeFor(state: BusState, piece: string, contract: BusContract): EmitScope {
  return ownScope(state, piece) ?? backgroundScope(state, piece, contract);
}

export function piecePort(state: BusState, piece: string): PiecePort {
  return {
    emit: (contract, payload) => {
      try {
        const busContract = busContractOf(contract);

        return emitFrom(scopeFor(state, piece, busContract), busContract, payload);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    request: async (contract, input, options) => {
      const busContract = busContractOf(contract);
      const scope = scopeFor(state, piece, busContract);
      const origin = { parent: scope.run, source: piece, late: scope.isLate() };

      return sendRequest(state, busContract, input, origin, options);
    },
  };
}
