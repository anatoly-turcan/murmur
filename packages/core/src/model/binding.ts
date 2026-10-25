import type { Capability } from './capability.ts';
import type { GuardClass } from './contract-class.ts';

export interface Binding<Req = unknown, Res = unknown, Params extends string = never> {
  readonly transport: string;
  readonly key: string;
  readonly capability?: Capability;
  readonly guards?: readonly GuardClass[];
  readonly '~req'?: Req;
  readonly '~res'?: Res;
  readonly '~params'?: Params;
}

export type AnyBinding = Binding<unknown, unknown, string>;

export interface ServedBinding {
  readonly piece: string;
  readonly binding: AnyBinding;
}

export interface BindingConflict {
  readonly first: ServedBinding;
  readonly second: ServedBinding;
  readonly message: string;
}

interface NormalisedKey {
  readonly verb: string;
  readonly segments: readonly string[];
  readonly wildcard: boolean;
}

function normaliseSegment(segment: string): string {
  if (segment.startsWith(':')) {
    return ':';
  }

  return segment;
}

export function normaliseKey(key: string): NormalisedKey {
  const space = key.indexOf(' ');
  const verb = space === -1 ? '' : key.slice(0, space);
  const parts = key
    .slice(space + 1)
    .split('/')
    .filter((part) => part !== '');
  const wildcard = parts.at(-1)?.startsWith('*') === true;
  const fixed = wildcard ? parts.slice(0, -1) : parts;

  return { verb, segments: fixed.map(normaliseSegment), wildcard };
}

export function routeIdentity(binding: AnyBinding): string {
  const { verb, segments, wildcard } = normaliseKey(binding.key);
  const tail = wildcard ? ['*'] : [];

  return `${binding.transport} ${verb} /${[...segments, ...tail].join('/')}`;
}

function verbsOverlap(a: NormalisedKey, b: NormalisedKey): boolean {
  return a.verb === b.verb || a.verb === '*' || b.verb === '*';
}

function startsWith(segments: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((segment, at) => segments[at] === segment);
}

function wildcardCovers(wild: NormalisedKey, other: NormalisedKey): boolean {
  if (other.wildcard) {
    return startsWith(other.segments, wild.segments) || startsWith(wild.segments, other.segments);
  }

  return other.segments.length > wild.segments.length && startsWith(other.segments, wild.segments);
}

function pathsOverlap(a: NormalisedKey, b: NormalisedKey): boolean {
  if (a.wildcard) {
    return wildcardCovers(a, b);
  }

  if (b.wildcard) {
    return wildcardCovers(b, a);
  }

  return a.segments.join('/') === b.segments.join('/');
}

export function bindingsConflict(a: AnyBinding, b: AnyBinding): boolean {
  if (a.transport !== b.transport) {
    return false;
  }

  const left = normaliseKey(a.key);
  const right = normaliseKey(b.key);

  return verbsOverlap(left, right) && pathsOverlap(left, right);
}

function conflictMessage(first: ServedBinding, second: ServedBinding): string {
  if (first.binding.key === second.binding.key) {
    return `route ${first.binding.key} is served by both ${first.piece} and ${second.piece}`;
  }

  return `route ${first.binding.key} (${first.piece}) overlaps ${second.binding.key} (${second.piece})`;
}

export function bindingConflicts(bindings: readonly ServedBinding[]): BindingConflict[] {
  return bindings.flatMap((first, at) =>
    bindings
      .slice(at + 1)
      .filter((second) => bindingsConflict(first.binding, second.binding))
      .map((second) => ({ first, second, message: conflictMessage(first, second) })),
  );
}

function segmentsCompatible(a: string, b: string): boolean {
  return a === b || a === ':' || b === ':';
}

function firstStaticUnderParam(a: NormalisedKey, b: NormalisedKey): 'a' | 'b' | undefined {
  const at = a.segments.findIndex((segment, index) => segment !== b.segments[index]);
  if (at === -1) {
    return undefined;
  }

  return a.segments[at] === ':' ? 'b' : 'a';
}

function shadowedSide(a: AnyBinding, b: AnyBinding): 'a' | 'b' | undefined {
  const left = normaliseKey(a.key);
  const right = normaliseKey(b.key);
  const sameShape =
    a.transport === b.transport &&
    !left.wildcard &&
    !right.wildcard &&
    left.segments.length === right.segments.length &&
    verbsOverlap(left, right);

  if (
    !sameShape ||
    !left.segments.every((segment, at) => segmentsCompatible(segment, right.segments[at] ?? ''))
  ) {
    return undefined;
  }

  return firstStaticUnderParam(left, right);
}

function shadowMessage(shadowed: ServedBinding, by: ServedBinding): string {
  return `route ${shadowed.binding.key} (${shadowed.piece}) sits under ${by.binding.key} (${by.piece}) and works only by the match rule: serve it from ${by.piece} or move it out of that path family`;
}

function shadowOf(first: ServedBinding, second: ServedBinding): BindingConflict[] {
  if (first.piece === second.piece) {
    return [];
  }

  const side = shadowedSide(first.binding, second.binding);
  if (side === undefined) {
    return [];
  }

  if (side === 'a') {
    return [{ first, second, message: shadowMessage(first, second) }];
  }

  return [{ first: second, second: first, message: shadowMessage(second, first) }];
}

export function routeShadows(bindings: readonly ServedBinding[]): BindingConflict[] {
  return bindings.flatMap((first, at) => bindings.slice(at + 1).flatMap((second) => shadowOf(first, second)));
}
