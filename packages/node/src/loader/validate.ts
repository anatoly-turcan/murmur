import { busContractOf, validatePieceId, type BusContract } from 'murmur';

import type { CapabilityEntry } from '../capabilities/registry.ts';
import type { BootError } from '../types.ts';
import { inScope, usedContracts, type ContractSource, type ValidPiece } from './candidate.ts';
import { messageOf } from './import.ts';

const DEFAULT_CAPABILITIES = new Set(['log', 'clock', 'ids']);

interface ContractOrigin {
  readonly contract: BusContract;
  readonly where: string;
}

export function pieceIdError(id: string, file: string): BootError | undefined {
  try {
    validatePieceId(id);

    return undefined;
  } catch (error) {
    return { phase: 'declaration', code: 'piece-id', message: messageOf(error), file };
  }
}

function originsOf(
  sources: readonly ContractSource[],
  pieces: readonly ValidPiece[],
  capabilities: readonly CapabilityEntry[],
): ContractOrigin[] {
  return [
    ...sources.map((s) => ({ contract: s.contract, where: s.file })),
    ...pieces.flatMap((p) => usedContracts(p).map((contract) => ({ contract, where: p.file }))),
    ...capabilities.flatMap((c) =>
      [...(c.definition.emits ?? []), ...(c.definition.requests ?? [])].map((contract) => ({
        contract: busContractOf(contract),
        where: c.file ?? `capability ${c.name}`,
      })),
    ),
  ];
}

export function contractIdentityErrors(
  sources: readonly ContractSource[],
  pieces: readonly ValidPiece[],
  capabilities: readonly CapabilityEntry[],
): BootError[] {
  const first = new Map<string, ContractOrigin>();
  const reported = new Set<string>();
  const errors: BootError[] = [];

  for (const origin of originsOf(sources, pieces, capabilities)) {
    const { name } = origin.contract;
    const seen = first.get(name);

    if (seen === undefined) {
      first.set(name, origin);
    } else if (seen.contract !== origin.contract && !reported.has(name)) {
      reported.add(name);
      errors.push({
        phase: 'contracts',
        code: 'contract-identity',
        message: `two contract objects are named ${name} (${seen.where}, ${origin.where}): define it once and import it`,
        file: origin.where,
      });
    }
  }

  return errors;
}

export function checkInternalScope(pieces: readonly ValidPiece[], sources: readonly ContractSource[]): void {
  const scopes = new Map(
    sources.flatMap((s) => (s.scope === null ? [] : [[s.contract.name, s.scope] as const])),
  );

  for (const piece of pieces) {
    for (const contract of new Set(usedContracts(piece))) {
      const scope = scopes.get(contract.name);
      if (scope === undefined || inScope(piece.id, scope)) {
        continue;
      }

      piece.errors.push({
        phase: 'contracts',
        code: 'internal-contract-scope',
        message: `${contract.name} is internal to pieces/${scope} and cannot be used by ${piece.id}`,
        file: piece.file,
      });
    }
  }
}

export function checkResponders(pieces: readonly ValidPiece[]): void {
  const owners = new Map<string, string>();
  for (const piece of pieces) {
    for (const { contract } of piece.definition.handlers) {
      if (contract.reply === undefined) {
        continue;
      }

      const owner = owners.get(contract.name);
      if (owner === undefined) {
        owners.set(contract.name, piece.id);
      } else {
        piece.errors.push({
          phase: 'contracts',
          message: `${contract.name} has more than one responder: ${owner}, ${piece.id}`,
          file: piece.file,
        });
      }
    }
  }
}

export function checkNeeds(pieces: readonly ValidPiece[], known: ReadonlySet<string>): void {
  for (const piece of pieces) {
    for (const name of piece.definition.needs) {
      if (known.has(name) || DEFAULT_CAPABILITIES.has(name)) {
        continue;
      }

      piece.errors.push({
        phase: 'needs',
        message: `${piece.id} needs "${name}" but no capability "${name}" is defined (known: ${[...known].join(', ')})`,
        file: piece.file,
      });
    }
  }
}

export function requiredCapabilities(pieces: readonly ValidPiece[], known: ReadonlySet<string>): string[] {
  return [...new Set(pieces.flatMap((p) => p.definition.needs))].filter((name) => known.has(name));
}
