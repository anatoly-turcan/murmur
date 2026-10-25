import { pathToFileURL } from 'node:url';

import { busContractOf, isContract, type AnyCapabilityDefinition, type BusContract } from 'murmur';

export type Imported =
  | { readonly ok: true; readonly module: Record<string, unknown> }
  | { readonly ok: false; readonly error: unknown };

export async function importFile(file: string): Promise<Imported> {
  try {
    return { ok: true, module: (await import(pathToFileURL(file).href)) as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error };
  }
}

export function contractsOf(module: Record<string, unknown>): BusContract[] {
  return [...new Set(Object.values(module).filter(isContract).map(busContractOf))];
}

export function capabilityOf(module: Record<string, unknown>): AnyCapabilityDefinition | undefined {
  const value = module['default'];
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }

  const named = typeof Reflect.get(value, 'name') === 'string';

  return named && typeof Reflect.get(value, 'start') === 'function'
    ? (value as AnyCapabilityDefinition)
    : undefined;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
