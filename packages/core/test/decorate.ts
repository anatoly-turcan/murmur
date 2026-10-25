import { metadataKey, type PieceApi } from 'murmur';
import { fakeClock, fakeIds, fakeLog } from 'murmur/testing';

type AnyDecorator = (value: never, context: never) => void;

export interface MethodDecoration {
  readonly decorators: readonly AnyDecorator[];
  readonly name: string | symbol;
  readonly get?: (instance: object) => unknown;
  readonly isStatic?: boolean;
}

export interface DecorateOptions {
  readonly linkParentMetadata?: boolean;
}

function metadataFor(target: object, linkParent: boolean): DecoratorMetadataObject {
  if (!linkParent) {
    return Object.create(null) as DecoratorMetadataObject;
  }

  const parent = Object.getPrototypeOf(target) as Record<symbol, unknown> | null;
  const inherited = (parent?.[metadataKey] ?? null) as object | null;

  return Object.create(inherited) as DecoratorMetadataObject;
}

function methodContext(member: MethodDecoration, metadata: DecoratorMetadataObject) {
  const get = member.get ?? ((instance: object) => Reflect.get(instance, member.name));
  const isPrivate = typeof member.name === 'string' && member.name.startsWith('#');

  return {
    kind: 'method',
    name: member.name,
    static: member.isStatic === true,
    private: isPrivate,
    metadata,
    access: { get, has: (instance: object) => member.name in instance },
    addInitializer: () => {},
  } as unknown as ClassMethodDecoratorContext;
}

function classContext(target: { name: string }, metadata: DecoratorMetadataObject) {
  return {
    kind: 'class',
    name: target.name,
    metadata,
    addInitializer: () => {},
  } as unknown as ClassDecoratorContext;
}

function apply(decorator: AnyDecorator, value: unknown, context: unknown): void {
  (decorator as unknown as (value: unknown, context: unknown) => void)(value, context);
}

export function decorate(
  target: abstract new () => object,
  members: readonly MethodDecoration[],
  classDecorators: readonly AnyDecorator[] = [],
  options: DecorateOptions = {},
): void {
  const metadata = metadataFor(target, options.linkParentMetadata ?? true);
  for (const member of members) {
    const value = Reflect.get(target.prototype as object, member.name);
    for (const decorator of member.decorators.toReversed()) {
      apply(decorator, value, methodContext(member, metadata));
    }
  }

  for (const decorator of classDecorators.toReversed()) {
    apply(decorator, target, classContext(target, metadata));
  }

  Object.defineProperty(target, metadataKey, { value: metadata, configurable: true });
}

export interface RecordingPort extends PieceApi {
  readonly emitted: { contract: unknown; payload: unknown }[];
  readonly requested: { contract: unknown; input: unknown }[];
  readonly resolved: { token: unknown; field: string }[];
}

export function recordingPort(
  handles: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
): RecordingPort {
  const emitted: RecordingPort['emitted'] = [];
  const requested: RecordingPort['requested'] = [];
  const resolved: RecordingPort['resolved'] = [];

  return {
    piece: 'test',
    log: fakeLog(),
    clock: fakeClock(),
    ids: fakeIds(),
    config,
    emitted,
    requested,
    resolved,
    resolve: (token, field) => {
      resolved.push({ token, field });

      return handles[field];
    },
    emit: async (contract, payload) => {
      emitted.push({ contract, payload });
    },
    request: async (contract, input) => {
      requested.push({ contract, input });

      return { answeredBy: 'port' };
    },
  };
}
