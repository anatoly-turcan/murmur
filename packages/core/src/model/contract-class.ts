import { z } from 'zod';

import { receivedLabel } from './errors.ts';
import { isModel, type ModelClass } from './model-class.ts';
import { checkedNameOverride, definingFile, derivedWireName } from './naming.ts';
import { Rejection } from './rejection.ts';
import {
  invalidSchema,
  isShape,
  isZodSchema,
  jsonSchemaOf,
  toObjectSchema,
  type ObjectSpec,
  type ParsedOf,
  type Shape,
  type UnparsedOf,
} from './schema.ts';
import type { Widest } from './widest.ts';

export type ContractKind = 'query' | 'command' | 'event' | 'guard';

export interface ContractOptions {
  readonly name?: string;
  readonly description?: string;
}

export type OutputSpec = ModelClass | z.ZodType | Shape;

export type SpecOutput<O> =
  O extends ModelClass<infer T>
    ? T
    : O extends z.ZodType<infer T>
      ? T
      : O extends Shape
        ? ParsedOf<O>
        : never;

export interface ContractClassJsonSchema {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly output?: Record<string, unknown>;
}

interface ContractStatics<K extends ContractKind, T, In> {
  new (data: T): T;
  readonly kind: K;
  readonly input: z.ZodType<T, In> & z.ZodObject;
  readonly file: string | undefined;
  readonly wireName: string;
  readonly description: string | undefined;
  jsonSchema(): ContractClassJsonSchema;
  readonly '~input'?: In;
}

interface Answered<Out> {
  readonly output: z.ZodType<Out>;
  readonly '~output'?: Out;
}

export interface QueryClass<T = Widest, In = Widest, Out = Widest>
  extends ContractStatics<'query', T, In>, Answered<Out> {}

export interface CommandClass<T = Widest, In = Widest, Out = Widest>
  extends ContractStatics<'command', T, In>, Answered<Out> {}

export interface GuardClass<T = Widest, In = Widest, Out = Widest, MetaIn = Widest>
  extends ContractStatics<'guard', T, In>, Answered<Out> {
  readonly model: ModelClass;
  readonly after: readonly GuardClass[];
  readonly optional: readonly GuardClass[];
  readonly meta: z.ZodObject;
  readonly '~meta'?: MetaIn;
}

export interface EventClass<T = Widest, In = Widest> extends ContractStatics<'event', T, In> {
  readonly output: undefined;
}

export type RequestClass<T = Widest, In = Widest, Out = Widest> =
  | QueryClass<T, In, Out>
  | CommandClass<T, In, Out>
  | GuardClass<T, In, Out>;

export type ContractClass = RequestClass | EventClass;

export type InputOf<C> = C extends ContractStatics<ContractKind, Widest, infer In> ? In : never;

export type OutputOf<C> = C extends RequestClass<Widest, Widest, infer Out> ? Out : void;

export interface GuardInput<
  Prior = Readonly<Record<string, unknown>>,
  Meta = Readonly<Record<string, unknown>>,
> {
  readonly transport: string;
  readonly operation: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly params: Readonly<Record<string, string>>;
  readonly peer: string;
  readonly ip: string;
  readonly meta: Meta;
  readonly prior: Prior;
}

export type GuardWireInput<
  Prior = Readonly<Record<string, unknown>>,
  MetaIn = Readonly<Record<string, unknown>>,
> = Omit<GuardInput<Prior, MetaIn>, 'meta' | 'prior'> & { readonly meta?: MetaIn; readonly prior?: Prior };

export interface GuardOptions<
  A extends readonly GuardClass[] = readonly GuardClass[],
  P extends readonly GuardClass[] = readonly GuardClass[],
  M extends Shape = Shape,
> extends ContractOptions {
  readonly after?: A;
  readonly optional?: P;
  readonly meta?: M;
}

type GuardOutput<G> = Exclude<OutputOf<G>, Rejection>;

type Intersect<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;

type AfterPrior<L extends readonly unknown[]> = L extends readonly []
  ? {}
  : Intersect<GuardOutput<L[number]>>;

type Maybe<T> = { readonly [K in keyof T]?: T[K] | undefined };

type OptionalPrior<L extends readonly unknown[]> = L extends readonly []
  ? {}
  : Maybe<Intersect<GuardOutput<L[number]>>>;

type MetaInputOf<M> = [keyof M] extends [never] ? {} : Partial<UnparsedOf<M>>;

export type PriorOf<A extends readonly unknown[], P extends readonly unknown[]> = AfterPrior<A> &
  OptionalPrior<P>;

const KINDS: readonly string[] = ['query', 'command', 'event', 'guard'] satisfies ContractKind[];
const wireNames = new WeakMap<object, string>();

function guardInputSchema(meta: z.ZodObject): z.ZodObject {
  return z.object({
    transport: z.string(),
    operation: z.string(),
    headers: z.record(z.string(), z.string()),
    params: z.record(z.string(), z.string()),
    peer: z.string(),
    ip: z.string(),
    meta: meta.prefault({}),
    prior: z.record(z.string(), z.unknown()).prefault({}),
  });
}

function toOutputSchema(spec: unknown, where: string): z.ZodType {
  if (isModel(spec)) {
    return spec.schema;
  }

  if (isZodSchema(spec)) {
    return spec;
  }

  if (isShape(spec)) {
    return z.object(spec);
  }

  throw invalidSchema(`${where}: expected a Model class, a zod schema or a shape of zod schemas`);
}

function wireNameOf(contract: object, explicit: string | undefined, file: string | undefined): string {
  const cached = wireNames.get(contract);
  if (cached !== undefined) {
    return cached;
  }

  const name = explicit ?? derivedWireName(file, Reflect.get(contract, 'name') as string);
  wireNames.set(contract, name);

  return name;
}

function contractClass(
  kind: ContractKind,
  input: z.ZodObject,
  output: z.ZodType | undefined,
  options: ContractOptions,
) {
  const file = definingFile();
  const explicit = checkedNameOverride(options.name);

  return class {
    static readonly kind = kind;
    static readonly input = input;
    static readonly output = output;
    static readonly file = file;
    static readonly description = options.description;

    static get wireName(): string {
      return wireNameOf(this, explicit, file);
    }

    static jsonSchema(): ContractClassJsonSchema {
      const described = { name: this.wireName, input: jsonSchemaOf(input) };
      if (output === undefined) {
        return described;
      }

      return { ...described, output: jsonSchemaOf(output) };
    }

    constructor(data: object) {
      Object.assign(this, data);
    }
  };
}

export function Query<S extends ObjectSpec, O extends OutputSpec>(
  input: S,
  output: O,
  options: ContractOptions = {},
): QueryClass<ParsedOf<S>, UnparsedOf<S>, SpecOutput<O>> {
  return contractClass(
    'query',
    toObjectSchema(input, 'Query() input'),
    toOutputSchema(output, 'Query() output'),
    options,
  ) as never;
}

export function Command<S extends ObjectSpec, O extends OutputSpec>(
  input: S,
  output: O,
  options: ContractOptions = {},
): CommandClass<ParsedOf<S>, UnparsedOf<S>, SpecOutput<O>> {
  return contractClass(
    'command',
    toObjectSchema(input, 'Command() input'),
    toOutputSchema(output, 'Command() output'),
    options,
  ) as never;
}

export function Event<S extends ObjectSpec>(
  payload: S,
  options: ContractOptions = {},
): EventClass<ParsedOf<S>, UnparsedOf<S>> {
  return contractClass('event', toObjectSchema(payload, 'Event() payload'), undefined, options) as never;
}

function guardList(list: readonly unknown[] = [], where: string): readonly GuardClass[] {
  const stray = list.findIndex((guard) => contractKind(guard) !== 'guard');
  if (stray !== -1) {
    throw invalidSchema(`Guard() ${where} lists Guard classes, ${receivedLabel(list[stray], 'guard')}`);
  }

  return Object.freeze([...list]) as readonly GuardClass[];
}

function metaSchema(meta: unknown): z.ZodObject {
  if (meta === undefined) {
    return z.object({});
  }

  if (!isShape(meta)) {
    throw invalidSchema('Guard() meta: expected a shape of zod schemas, like { role: z.string() }');
  }

  return z.object(meta);
}

export function Guard<
  O extends ModelClass,
  const A extends readonly GuardClass[] = [],
  const P extends readonly GuardClass[] = [],
  M extends Shape = {},
>(
  output: O,
  options: GuardOptions<A, P, M> = {},
): GuardClass<
  GuardInput<PriorOf<A, P>, ParsedOf<M>>,
  GuardWireInput<PriorOf<A, P>, UnparsedOf<M>>,
  InstanceType<O> | Rejection,
  MetaInputOf<M>
> {
  if (!isModel(output)) {
    throw invalidSchema(`Guard(): the output must be a Model class, ${receivedLabel(output, 'model')}`);
  }

  const after = guardList(options.after, 'after');
  const optional = guardList(options.optional, 'optional');
  const meta = metaSchema(options.meta);
  const contract = contractClass(
    'guard',
    guardInputSchema(meta),
    z.union([Rejection.schema, output.schema]),
    options,
  );

  return class extends contract {
    static readonly model = output;
    static readonly after = after;
    static readonly optional = optional;
    static readonly meta = meta;
  } as never;
}

export function contractKind(value: unknown): ContractKind | undefined {
  if (typeof value !== 'function') {
    return undefined;
  }

  const kind = Reflect.get(value, 'kind');
  if (typeof kind !== 'string' || !KINDS.includes(kind) || !isZodSchema(Reflect.get(value, 'input'))) {
    return undefined;
  }

  return kind as ContractKind;
}

export function isContract(value: unknown): value is ContractClass {
  return contractKind(value) !== undefined;
}

export function isRequestClass(value: unknown): value is RequestClass {
  const kind = contractKind(value);

  return kind !== undefined && kind !== 'event';
}
