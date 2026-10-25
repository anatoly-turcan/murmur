import type { Binding, GuardClass, OutputOf, Rejection } from 'murmur';
import type { z } from 'zod';

export type PathParams<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParams<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

type Part = z.ZodObject | z.ZodRawShape;

export interface ReadSpec {
  readonly params?: Part;
  readonly query?: Part;
  readonly headers?: Part;
  readonly body?: Part;
}

type Parsed<S> = S extends z.ZodObject
  ? z.output<S>
  : S extends z.ZodRawShape
    ? z.output<z.ZodObject<S>>
    : never;

export interface ReplyOptions<B> {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly etag?: string | number | ((body: B) => string | number);
}

export interface HttpRequest<Auth = undefined> {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly headers: Headers;
  readonly auth: Auth;
  readonly signal: AbortSignal;
  read<const S extends ReadSpec>(spec: S): Promise<{ readonly [K in keyof S]-?: Parsed<S[K]> }>;
  reply<O>(outcome: O, options?: ReplyOptions<Exclude<O, Rejection | Response | null | undefined>>): Response;
}

type JsonObject = object & { readonly getTime?: never; readonly call?: never };

export type HttpResult = Response | JsonObject | Rejection | null | undefined;

export interface RouteOptions {
  readonly status?: number;
  readonly guards?: readonly GuardClass[];
  readonly skip?: readonly GuardClass[];
}

type Without<G, S> = G extends readonly [infer Head, ...infer Rest]
  ? [Head] extends [S]
    ? Without<Rest, S>
    : [Head, ...Without<Rest, S>]
  : [];

type SkipOf<O> = O extends { readonly skip: readonly (infer S)[] } ? S : never;

type ExtraOf<O> = O extends { readonly guards: infer X extends readonly GuardClass[] } ? X : [];

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void
  ? I
  : never;

type Merge<L extends readonly unknown[]> = L extends readonly []
  ? undefined
  : UnionToIntersection<Exclude<OutputOf<L[number]>, Rejection>>;

export type AuthOf<G, O> = Merge<[...Without<G, SkipOf<O>>, ...ExtraOf<O>]>;

export interface HttpBinding<P extends string, Auth> extends Binding<
  HttpRequest<Auth>,
  HttpResult,
  PathParams<P>
> {
  readonly transport: 'http';
}

type Maker<G> = <const P extends string, const O extends RouteOptions = {}>(
  path: P,
  options?: O,
) => HttpBinding<P, AuthOf<G, O>>;

export interface HttpToken<G extends readonly GuardClass[]> {
  readonly name: 'web';
  start(): unknown;
  readonly guards: G;
  readonly '~auth'?: AuthOf<G, {}>;
  readonly get: Maker<G>;
  readonly post: Maker<G>;
  readonly delete: Maker<G>;
}

export type RequestOf<T> = T extends HttpToken<infer G> ? HttpRequest<AuthOf<G, {}>> : never;

function maker(method: string) {
  return (path: string) => ({ transport: 'http', key: `${method} ${path}` });
}

export function http<const G extends readonly GuardClass[] = []>(
  options: { readonly guards?: G } = {},
): HttpToken<G> {
  return {
    name: 'web',
    start: () => ({}),
    guards: (options.guards ?? []) as G,
    get: maker('GET') as never,
    post: maker('POST') as never,
    delete: maker('DELETE') as never,
  };
}
