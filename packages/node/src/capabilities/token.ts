import type { AnyCapabilityDefinition } from 'murmur';

export type CallableToken<D> = D & (() => D);

export function callableToken<D extends AnyCapabilityDefinition>(definition: D): CallableToken<D> {
  const { name, ...rest } = definition;
  const token = (() => token) as unknown as CallableToken<D>;
  Object.defineProperty(token, 'name', { value: name });
  Object.defineProperties(token, Object.getOwnPropertyDescriptors(rest));

  return token;
}
