import type { AnyBinding } from './binding.ts';
import type { ContractClass, RequestClass } from './contract-class.ts';
import type { Delivery } from './delivery.ts';
import type { Duration, JobRetry } from './jobs.ts';

export type PortMethod = (this: object, input: unknown, delivery: Delivery) => unknown;

export interface HandlerEntry {
  readonly contract: ContractClass;
  readonly method: string | symbol;
  readonly get: (instance: object) => PortMethod;
  readonly every: Duration | undefined;
  readonly retry: JobRetry | undefined;
}

export interface ServeEntry {
  readonly binding: AnyBinding;
  readonly method: string | symbol | undefined;
  readonly get: ((instance: object) => PortMethod) | undefined;
  readonly contract: RequestClass | undefined;
}

export const metadataKey: symbol = Symbol.metadata ?? Symbol.for('Symbol.metadata');

export const HANDLERS: unique symbol = Symbol.for('murmur.handlers');
export const SERVES: unique symbol = Symbol.for('murmur.serves');

type EntryKey = typeof HANDLERS | typeof SERVES;

type Bag = Record<EntryKey, unknown[] | undefined>;

export function ownEntries<T>(metadata: DecoratorMetadataObject, key: EntryKey): T[] {
  const bag = metadata as unknown as Bag;
  const own = Object.hasOwn(bag, key) ? bag[key] : undefined;

  if (own !== undefined) {
    return own as T[];
  }

  const created: T[] = [];
  bag[key] = created;

  return created;
}

function classChain(target: object | null): object[] {
  if (target === null || target === Function.prototype) {
    return [];
  }

  return [...classChain(Object.getPrototypeOf(target) as object | null), target];
}

function ownMetadata(target: object): object | undefined {
  if (!Object.hasOwn(target, metadataKey)) {
    return undefined;
  }

  return Reflect.get(target, metadataKey) as object | undefined;
}

function ownEntriesOf<T>(metadata: object | undefined, key: EntryKey): T[] {
  if (metadata === undefined || !Object.hasOwn(metadata, key)) {
    return [];
  }

  return ((metadata as Bag)[key] ?? []) as T[];
}

export function inheritedEntries<T>(target: object, key: EntryKey): T[] {
  return classChain(target).flatMap((level) => ownEntriesOf<T>(ownMetadata(level), key));
}
