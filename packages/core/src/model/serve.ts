import { bindingsConflict, type AnyBinding, type Binding } from './binding.ts';
import { isRequestClass, type InputOf, type RequestClass } from './contract-class.ts';
import type { Delivery } from './delivery.ts';
import { PieceDefinitionError, receivedLabel } from './errors.ts';
import { ownEntries, SERVES, type PortMethod, type ServeEntry } from './metadata.ts';

export type BindingRequest<B> = B extends Binding<infer Req, unknown, string> ? Req : never;

export type BindingResult<B> = B extends Binding<unknown, infer Res, string> ? Res : never;

type BindingParams<B> = B extends Binding<unknown, unknown, infer Params> ? Params : never;

type MissingParams<B, C> = Exclude<BindingParams<B>, keyof InputOf<C>>;

export type Covers<B, C> = [MissingParams<B, C>] extends [never]
  ? unknown
  : {
      readonly '~murmur': `path param :${MissingParams<B, C> & string} is not a field of the contract input`;
    };

type ParamsOf<M> = M extends (...args: infer A) => unknown ? A : never;

type DeclaredRequest<M> = M extends (req: infer Req, ...rest: never[]) => unknown ? Req : never;

type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type ExactRequest<M, B> =
  ParamsOf<M> extends []
    ? unknown
    : SameType<DeclaredRequest<M>, BindingRequest<B>> extends true
      ? unknown
      : { readonly '~murmur': "the request parameter does not match this binding's request type" };

type ServeMethod<This, B> = (
  this: This,
  req: BindingRequest<B>,
  delivery: Delivery,
) => Promise<BindingResult<B>> | BindingResult<B>;

function assertBinding(binding: unknown): asserts binding is AnyBinding {
  const transport = Reflect.get(Object(binding), 'transport');
  const key = Reflect.get(Object(binding), 'key');

  if (typeof transport !== 'string' || typeof key !== 'string') {
    throw new PieceDefinitionError(
      `@Serve() expects a binding made by an ingress capability, like web.get(...), ${receivedLabel(binding, 'binding')}`,
    );
  }
}

function assertPlacement(context: DecoratorContext, contract: RequestClass | undefined, key: string): void {
  if (contract === undefined && (context.kind !== 'method' || context.static)) {
    throw new PieceDefinitionError(`@Serve(${key}) without a contract goes on an instance method`);
  }

  if (contract !== undefined && context.kind !== 'class') {
    throw new PieceDefinitionError(
      `@Serve(${key}, Contract) is the class-level shorthand: put it above the class`,
    );
  }
}

function recordServe(metadata: DecoratorMetadataObject, entry: ServeEntry, atClass: boolean): void {
  const serves = ownEntries<ServeEntry>(metadata, SERVES);
  const clash = serves.find((existing) => bindingsConflict(existing.binding, entry.binding));

  if (clash !== undefined) {
    throw new PieceDefinitionError(
      `@Serve(${entry.binding.key}) conflicts with @Serve(${clash.binding.key}) in the same piece`,
    );
  }

  if (atClass) {
    serves.unshift(entry);

    return;
  }

  serves.push(entry);
}

function methodEntry(binding: AnyBinding, context: ClassMethodDecoratorContext): ServeEntry {
  return {
    binding,
    method: context.name,
    get: context.access.get as (instance: object) => PortMethod,
    contract: undefined,
  };
}

export function Serve<B extends AnyBinding>(
  binding: B,
): <This, M extends ServeMethod<This, B>>(
  value: M & ExactRequest<M, B>,
  context: ClassMethodDecoratorContext<This, M>,
) => void;
export function Serve<B extends AnyBinding, C extends RequestClass>(
  binding: B,
  contract: C & Covers<B, C>,
): (value: abstract new () => object, context: ClassDecoratorContext) => void;
export function Serve(binding: AnyBinding, ...forwardTo: RequestClass[]): unknown {
  const contract = forwardTo[0];
  assertBinding(binding);

  if (forwardTo.length > 0 && !isRequestClass(contract)) {
    throw new PieceDefinitionError(
      `@Serve(${binding.key}, …) forwards to a Query, Command or Guard class, ${receivedLabel(contract, 'contract')}`,
    );
  }

  return (_value: unknown, context: ClassMethodDecoratorContext | ClassDecoratorContext) => {
    assertPlacement(context, contract, binding.key);

    if (context.kind === 'class') {
      recordServe(context.metadata, { binding, method: undefined, get: undefined, contract }, true);

      return;
    }

    recordServe(context.metadata, methodEntry(binding, context), false);
  };
}
