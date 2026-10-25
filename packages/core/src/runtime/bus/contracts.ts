import { contractKind, type ContractClass, type ContractKind } from '../../model/contract-class.ts';
import { MurmurError } from '../../model/errors.ts';
import type { Schema } from '../../model/schema.ts';

export interface BusContract {
  readonly name: string;
  readonly kind: ContractKind;
  readonly payload: Schema;
  readonly reply: Schema | undefined;
}

const adapted = new WeakMap<ContractClass, BusContract>();

function adapt(contract: ContractClass): BusContract {
  return Object.freeze({
    name: contract.wireName,
    kind: contract.kind,
    payload: contract.input,
    reply: contract.output,
  });
}

function cachedAdapter(contract: ContractClass): BusContract {
  const cached = adapted.get(contract);
  if (cached !== undefined) {
    return cached;
  }

  const created = adapt(contract);
  adapted.set(contract, created);

  return created;
}

export function busContractOf(contract: ContractClass): BusContract {
  if (contractKind(contract) !== undefined) {
    return cachedAdapter(contract);
  }

  throw new MurmurError(`expected a contract class, got ${String(Reflect.get(Object(contract), 'name'))}`, {
    code: 'not-a-contract',
    retryable: false,
  });
}

export function isQueryContract(contract: BusContract): boolean {
  return contract.kind === 'query';
}
