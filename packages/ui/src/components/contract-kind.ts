import type { CatalogRoute, ContractKind, ContractView } from '@murmur/dev-protocol';

export interface KindMark {
  letter: string;
  title: string;
}

const LETTERS: Record<ContractKind, string> = { query: 'Q', command: 'C', event: 'E', guard: 'G' };

export function kindMark(contract: Pick<ContractView, 'kind'>): KindMark {
  return { letter: LETTERS[contract.kind], title: contract.kind };
}

export function displayName(contract: Pick<ContractView, 'className'>): string {
  return contract.className;
}

export function classNameOf(wireName: string, contracts: readonly ContractView[]): string {
  const contract = contracts.find((c) => c.name === wireName);

  return contract === undefined ? wireName : displayName(contract);
}

export function routeTarget(route: CatalogRoute, contracts: readonly ContractView[]): string {
  if (route.contract === undefined) {
    return `method ${route.method ?? ''}`.trim();
  }

  const status = route.status === undefined ? '' : ` (${route.status})`;

  return `→ ${classNameOf(route.contract, contracts)}${status}`;
}
