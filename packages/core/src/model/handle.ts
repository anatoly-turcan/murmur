import { isContract, type ContractClass, type OutputOf, type RequestClass } from './contract-class.ts';
import type { Delivery } from './delivery.ts';
import { PieceDefinitionError, receivedLabel } from './errors.ts';
import {
  everyFormatProblem,
  everyInputProblem,
  retryKindProblem,
  retryLadderProblem,
  type HandleOptions,
} from './jobs.ts';
import { HANDLERS, ownEntries, type HandlerEntry, type PortMethod } from './metadata.ts';

type Answer<O> = {} extends O ? O | void : O;

export type Reply<C> = C extends RequestClass
  ? Answer<OutputOf<C>> | Promise<Answer<OutputOf<C>>>
  : void | Promise<void>;

type ReturnOf<M> = M extends (...args: never[]) => infer R ? Awaited<R> : never;

type KeysOf<T> = T extends unknown ? keyof T : never;

type ExtraKeys<R, O> = R extends object ? Exclude<keyof R, KeysOf<NonNullable<O>>> : never;

export type Exact<M, C> = C extends RequestClass
  ? [ExtraKeys<ReturnOf<M>, OutputOf<C>>] extends [never]
    ? unknown
    : { readonly '~murmur': `output has no key "${ExtraKeys<ReturnOf<M>, OutputOf<C>> & string}"` }
  : unknown;

type HandlerMethod<This, C extends ContractClass> = (
  this: This,
  input: InstanceType<C>,
  delivery: Delivery,
) => Reply<C>;

function assertContract(contract: unknown): asserts contract is ContractClass {
  if (!isContract(contract)) {
    throw new PieceDefinitionError(
      `@Handle() expects a contract class (Query, Command, Event or Guard), ${receivedLabel(contract, 'contract')}`,
    );
  }
}

function assertInstanceMethod(context: ClassMethodDecoratorContext): void {
  if (context.kind !== 'method' || context.static) {
    throw new PieceDefinitionError(`@Handle goes on an instance method, not on ${String(context.name)}`);
  }
}

function recordHandler(metadata: DecoratorMetadataObject, entry: HandlerEntry): void {
  const handlers = ownEntries<HandlerEntry>(metadata, HANDLERS);
  const twin = handlers.find((existing) => existing.contract === entry.contract);

  if (twin !== undefined) {
    throw new PieceDefinitionError(
      `@Handle(${entry.contract.name}) is declared twice in one piece: ${String(twin.method)} and ${String(entry.method)}`,
    );
  }

  handlers.push(entry);
}

function requiresInput(contract: ContractClass): boolean {
  return !contract.input.safeParse({}).success;
}

function optionsProblem(contract: ContractClass, options: HandleOptions): string | undefined {
  const retry = options.retry === undefined ? undefined : retryKindProblem(contract.name, contract.kind);
  const every =
    options.every === undefined
      ? undefined
      : (everyFormatProblem(options.every) ??
        everyInputProblem(
          contract.name,
          contract.kind,
          contract.kind === 'command' && requiresInput(contract),
        ));

  return every ?? retry ?? (options.retry === undefined ? undefined : retryLadderProblem(options.retry));
}

function assertOptions(contract: ContractClass, options: HandleOptions): void {
  const problem = optionsProblem(contract, options);
  if (problem !== undefined) {
    throw new PieceDefinitionError(problem);
  }
}

export function Handle<C extends ContractClass>(
  contract: C,
  options?: HandleOptions,
): <This, M extends HandlerMethod<This, C>>(
  value: M & Exact<M, C>,
  context: ClassMethodDecoratorContext<This, M>,
) => void;
export function Handle(contract: ContractClass, options: HandleOptions = {}): unknown {
  assertContract(contract);
  assertOptions(contract, options);

  return (_value: unknown, context: ClassMethodDecoratorContext) => {
    assertInstanceMethod(context);
    recordHandler(context.metadata, {
      contract,
      method: context.name,
      get: context.access.get as (instance: object) => PortMethod,
      every: options.every,
      retry: options.retry,
    });
  };
}

function emptyAnswer(contract: ContractClass, value: unknown): unknown {
  if (value !== undefined || contract.output === undefined) {
    return value;
  }

  return contract.output.safeParse({}).success ? {} : value;
}

export function answerOf(contract: ContractClass, result: unknown): unknown {
  if (result instanceof Promise) {
    return result.then((value: unknown) => emptyAnswer(contract, value));
  }

  return emptyAnswer(contract, result);
}
