import type { z } from 'zod';

import { bindingsConflict, routeIdentity } from './binding.ts';
import type { Clock, Ids, Log } from './capabilities.ts';
import { isCapabilityToken, type Capability, type HandleOf } from './capability.ts';
import {
  contractKind,
  type EventClass,
  type InputOf,
  type OutputOf,
  type RequestClass,
} from './contract-class.ts';
import { EmitNotDeclaredError, MurmurError, NotRequestableError, PieceDefinitionError } from './errors.ts';
import { HANDLERS, inheritedEntries, SERVES, type HandlerEntry, type ServeEntry } from './metadata.ts';
import { definingFile } from './naming.ts';
import type { PiecePolicy, RequestOptions } from './policy.ts';
import { isZodSchema } from './schema.ts';

export type Needs = Readonly<Record<string, Capability>>;

export type ConfigShape = Readonly<Record<string, z.ZodType>>;

export type ConfigOf<Cfg> = {
  readonly [K in keyof Cfg]: Cfg[K] extends z.ZodType ? z.output<Cfg[K]> : never;
};

export type Injected<N> = { readonly [K in keyof N]: HandleOf<N[K]> };

export interface PieceDeclaration<
  N extends Needs = Needs,
  Cfg extends ConfigShape = ConfigShape,
  E extends readonly EventClass[] = readonly EventClass[],
> {
  readonly needs?: N;
  readonly config?: Cfg;
  readonly emits?: E;
  readonly policy?: PiecePolicy;
}

export interface PieceDefaults {
  readonly log: Log;
  readonly clock: Clock;
  readonly ids: Ids;
}

type Declared<C, E> = [C] extends [E]
  ? unknown
  : { readonly '~murmur': "not declared: add it to this piece's emits" };

export interface PieceMessaging<E> {
  emit<C extends EventClass>(contract: C & Declared<C, E>, payload: InputOf<C>): Promise<void>;
  request<C extends RequestClass>(
    contract: C,
    input: InputOf<C>,
    options?: RequestOptions,
  ): Promise<OutputOf<C>>;
}

export type PieceInstance<N, Cfg, E> = Injected<N> &
  PieceDefaults & { readonly config: ConfigOf<Cfg> } & PieceMessaging<E>;

export interface PieceStatics {
  readonly declaration: PieceDeclaration;
}

export interface DeclaredShape<N, Cfg, E> {
  readonly needs: N;
  readonly config: Cfg;
  readonly emits: E;
}

export type PieceBaseClass<N, Cfg, E> = (abstract new () => PieceInstance<N, Cfg, E>) &
  PieceStatics & { readonly '~declaration'?: DeclaredShape<N, Cfg, E> };

export type PieceClass = (abstract new () => object) & PieceStatics;

export interface PieceApi {
  readonly piece: string;
  readonly log: Log;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly config: Readonly<Record<string, unknown>>;
  resolve(token: Capability, field: string): unknown;
  emit(contract: EventClass, payload: unknown): Promise<void>;
  request(contract: RequestClass, input: unknown, options?: RequestOptions): Promise<unknown>;
}

export interface PieceDescription {
  readonly declaration: PieceDeclaration;
  readonly handlers: readonly HandlerEntry[];
  readonly serves: readonly ServeEntry[];
}

const RESERVED_FIELDS = new Set(['log', 'clock', 'ids', 'config', 'emit', 'request', 'onStart', 'onStop']);
const ports = new WeakMap<object, PieceApi>();
const pieceBases = new WeakSet<object>();
const pieceFiles = new WeakMap<object, string>();
let constructing: PieceApi | undefined;

function claimPort(): PieceApi {
  const port = constructing;
  constructing = undefined;

  if (port === undefined) {
    throw new MurmurError('pieces are constructed by the runtime, not with new', {
      code: 'piece-constructed-directly',
      retryable: false,
    });
  }

  return port;
}

function portOf(piece: object): PieceApi {
  const port = ports.get(piece);
  if (port === undefined) {
    throw new MurmurError('this piece was not constructed by the runtime', {
      code: 'piece-constructed-directly',
      retryable: false,
    });
  }

  return port;
}

function contractLabel(contract: unknown): string {
  return String(Reflect.get(Object(contract), 'name') ?? contract);
}

function checkNeeds(needs: Needs): void {
  for (const [field, token] of Object.entries(needs)) {
    if (RESERVED_FIELDS.has(field)) {
      throw new PieceDefinitionError(`Piece({ needs }): ${field} is a reserved field name; pick another`);
    }

    if (!isCapabilityToken(token)) {
      throw new PieceDefinitionError(`Piece({ needs }): ${field} is not a capability token`);
    }
  }
}

function checkConfig(config: ConfigShape): void {
  for (const [key, schema] of Object.entries(config)) {
    if (!isZodSchema(schema)) {
      throw new PieceDefinitionError(`Piece({ config }): ${key} is not a zod schema`);
    }
  }
}

function checkEmits(emits: readonly EventClass[]): void {
  const seen = new Set<unknown>();
  for (const contract of emits) {
    const kind = contractKind(contract);
    if (kind !== 'event') {
      throw new PieceDefinitionError(
        `Piece({ emits }): ${contractLabel(contract)} is ${kind === undefined ? 'not a contract' : `a ${kind}`}; emits lists events only`,
      );
    }

    if (seen.has(contract)) {
      throw new PieceDefinitionError(`Piece({ emits }): ${contract.name} is listed twice`);
    }

    seen.add(contract);
  }
}

function checkDeclaration(declaration: PieceDeclaration): PieceDeclaration {
  checkNeeds(declaration.needs ?? {});
  checkConfig(declaration.config ?? {});
  checkEmits(declaration.emits ?? []);

  return Object.freeze({ ...declaration });
}

function injectNeeds(piece: object, needs: Needs, port: PieceApi): void {
  for (const [field, token] of Object.entries(needs)) {
    Object.defineProperty(piece, field, { value: port.resolve(token, field), enumerable: false });
  }
}

function assertDeclared(declaration: PieceDeclaration, port: PieceApi, contract: EventClass): void {
  if (!(declaration.emits ?? []).includes(contract)) {
    const label = contractKind(contract) === undefined ? contractLabel(contract) : contract.wireName;
    throw new EmitNotDeclaredError(port.piece, label, "add it to this piece's emits");
  }
}

function assertRequestable(contract: RequestClass): void {
  if (contractKind(contract) === 'event') {
    throw new NotRequestableError(contract.wireName);
  }
}

export function Piece<
  const N extends Needs = {},
  const Cfg extends ConfigShape = {},
  const E extends readonly EventClass[] = [],
>(declaration: PieceDeclaration<N, Cfg, E> = {}): PieceBaseClass<N, Cfg, E[number]> {
  const declared = checkDeclaration(declaration);
  const file = definingFile();

  abstract class PieceBase {
    static readonly declaration: PieceDeclaration = declared;

    constructor() {
      const port = claimPort();
      ports.set(this, port);
      injectNeeds(this, declared.needs ?? {}, port);
    }

    get log(): Log {
      return portOf(this).log;
    }

    get clock(): Clock {
      return portOf(this).clock;
    }

    get ids(): Ids {
      return portOf(this).ids;
    }

    get config(): Readonly<Record<string, unknown>> {
      return portOf(this).config;
    }

    emit(contract: EventClass, payload: unknown): Promise<void> {
      const port = portOf(this);

      try {
        assertDeclared(declared, port, contract);
      } catch (error) {
        return Promise.reject(error);
      }

      return port.emit(contract, payload);
    }

    async request(contract: RequestClass, input: unknown, options?: RequestOptions): Promise<unknown> {
      assertRequestable(contract);

      return portOf(this).request(contract, input, options);
    }
  }

  pieceBases.add(PieceBase);

  if (file !== undefined) {
    pieceFiles.set(PieceBase, file);
  }

  return PieceBase as never;
}

export function pieceFileOf(piece: PieceClass): string | undefined {
  const base = ancestorsOf(piece).find((ancestor) => pieceBases.has(ancestor));

  return base === undefined ? undefined : pieceFiles.get(base);
}

export function constructPiece<P extends PieceClass>(piece: P, port: PieceApi): InstanceType<P> {
  const previous = constructing;
  constructing = port;

  try {
    return new (piece as unknown as new () => InstanceType<P>)();
  } finally {
    constructing = previous;
  }
}

function ancestorsOf(value: object): object[] {
  const parent = Object.getPrototypeOf(value) as object | null;
  if (parent === null) {
    return [];
  }

  return [parent, ...ancestorsOf(parent)];
}

export function isPieceClass(value: unknown): value is PieceClass {
  return typeof value === 'function' && ancestorsOf(value).some((ancestor) => pieceBases.has(ancestor));
}

function lastWins<T>(entries: readonly T[], keyOf: (entry: T) => unknown): T[] {
  const byKey = new Map(entries.map((entry) => [keyOf(entry), entry]));

  return [...byKey.values()];
}

function servedBy(entry: ServeEntry): string {
  if (entry.method === undefined) {
    return 'the class';
  }

  return String(entry.method);
}

function assertNoOverlap(piece: PieceClass, serves: readonly ServeEntry[]): void {
  serves.forEach((first, at) => {
    const second = serves.slice(at + 1).find((other) => bindingsConflict(first.binding, other.binding));
    if (second !== undefined) {
      throw new PieceDefinitionError(
        `@Serve(${first.binding.key}) on ${servedBy(first)} overlaps @Serve(${second.binding.key}) on ${servedBy(second)} in ${piece.name}`,
      );
    }
  });
}

export function describePiece(piece: PieceClass): PieceDescription {
  if (!isPieceClass(piece)) {
    throw new PieceDefinitionError(
      `describePiece: ${String(Reflect.get(Object(piece), 'name'))} does not extend Piece()`,
    );
  }

  const handlers = inheritedEntries<HandlerEntry>(piece, HANDLERS);
  const serves = lastWins(inheritedEntries<ServeEntry>(piece, SERVES), (entry) =>
    routeIdentity(entry.binding),
  );

  assertNoOverlap(piece, serves);

  return Object.freeze({
    declaration: piece.declaration,
    handlers: Object.freeze(lastWins(handlers, (entry) => entry.contract)),
    serves: Object.freeze(serves),
  });
}
