import { busContractOf, type BusContract } from 'murmur';

import type { CapabilityEntry } from '../capabilities/registry.ts';
import type { BootWarning, Catalog, CatalogContract } from '../types.ts';
import type { ContractSource, ValidPiece } from './candidate.ts';

const external = (capability: string) => `(external: ${capability})`;
const isExternal = (emitter: string) => emitter.startsWith('(external: ');

function entryFor(contracts: Map<string, CatalogContract>, contract: BusContract): CatalogContract {
  const existing = contracts.get(contract.name);
  if (existing !== undefined) {
    return existing;
  }

  const created: CatalogContract = {
    name: contract.name,
    hasReply: contract.reply !== undefined,
    visibility: 'public',
    scope: null,
    file: null,
    emitters: [],
    handlers: [],
  };
  contracts.set(contract.name, created);

  return created;
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

export function buildCatalog(
  sources: readonly ContractSource[],
  pieces: readonly ValidPiece[],
  capabilities: readonly CapabilityEntry[],
): Catalog {
  const contracts = new Map<string, CatalogContract>();
  for (const source of sources) {
    Object.assign(entryFor(contracts, source.contract), {
      visibility: source.visibility,
      scope: source.scope,
      file: source.file,
    });
  }

  for (const piece of pieces) {
    const { emits, handlers } = piece.definition;
    for (const contract of emits) {
      addUnique(entryFor(contracts, contract).emitters, piece.id);
    }

    for (const { contract } of handlers) {
      addUnique(entryFor(contracts, contract).handlers, piece.id);
    }
  }

  for (const capability of capabilities) {
    const { emits = [], requests = [] } = capability.definition;
    for (const contract of [...emits, ...requests]) {
      addUnique(entryFor(contracts, busContractOf(contract)).emitters, external(capability.name));
    }
  }

  return {
    contracts: [...contracts.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
    capabilities: capabilities.map((c) => ({
      name: c.name,
      kind: c.definition.ingress === true ? 'ingress' : 'handle',
      usedBy: pieces.filter((p) => p.definition.needs.includes(c.name)).map((p) => p.id),
    })),
  };
}

function flowWarning(contract: CatalogContract): BootWarning | undefined {
  const { name, emitters, handlers } = contract;
  if (handlers.length > 0 && emitters.length === 0) {
    return {
      code: 'subscribed-never-emitted',
      subject: name,
      pieces: handlers,
      message: `${name} is handled but nothing emits it`,
    };
  }

  if (emitters.length === 0 || handlers.length > 0) {
    return undefined;
  }

  const pieces = emitters.filter((e) => !isExternal(e));
  if (contract.hasReply) {
    return {
      code: 'requested-never-handled',
      subject: name,
      pieces,
      message: `${name} is requested but has no responder`,
    };
  }

  return {
    code: 'emitted-never-subscribed',
    subject: name,
    pieces,
    message: `${name} is emitted but nothing handles it`,
  };
}

export function catalogWarnings(catalog: Catalog): BootWarning[] {
  return catalog.contracts.flatMap((contract) => flowWarning(contract) ?? []);
}
