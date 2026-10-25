import {
  PieceDefinitionError,
  type Binding,
  type Capability,
  type GuardClass,
  type OutputOf,
  type Rejection,
} from 'murmur';

import { assertAdmission } from './admission.ts';
import type { ErrorSettings } from './errors.ts';
import { assertNoGuardOverlap } from './guards.ts';
import { assertIdempotent } from './idempotent-route.ts';
import type { HttpRequest, HttpResult } from './request.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type PathParams<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParams<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

export interface IdempotentOptions {
  readonly scope: readonly string[];
  readonly ttlMs?: number;
  readonly header?: string;
}

export interface RouteOptions {
  readonly status?: number;
  readonly guards?: readonly GuardClass[];
  readonly skip?: readonly GuardClass[];
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly idempotent?: IdempotentOptions;
}

type DefaultGuard<G> = G extends readonly GuardClass[] ? G[number] : GuardClass;

type MetaIn<X> = X extends { readonly '~meta'?: infer M } ? Exclude<M, undefined> : never;

type MetaOf<G> = G extends readonly []
  ? {}
  : G extends readonly GuardClass[]
    ? UnionToIntersection<MetaIn<G[number]>>
    : {};

export interface RouteOptionsFor<G> extends RouteOptions {
  readonly skip?: readonly DefaultGuard<G>[];
  readonly meta?: MetaOf<G> & Readonly<Record<string, unknown>>;
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

export type AuthHook<R> = (auth: Readonly<Record<string, unknown>>) => R;

export interface HttpSettings {
  readonly guards: readonly GuardClass[];
  readonly errors: ErrorSettings;
  readonly maxBodyBytes: number;
  readonly responseHeaders?: AuthHook<Record<string, string>> | undefined;
  readonly log?: AuthHook<Record<string, unknown>> | undefined;
}

interface HttpRouteFields {
  readonly transport: 'http';
  readonly capability: Capability;
  readonly guards: readonly GuardClass[];
  readonly method: HttpMethod | '*';
  readonly path: string;
  readonly raw: boolean;
  readonly options: RouteOptions;
  readonly settings: HttpSettings;
}

export interface HttpBinding<P extends string = string, Auth = unknown>
  extends Binding<HttpRequest<Auth>, HttpResult, PathParams<P>>, HttpRouteFields {
  readonly transport: 'http';
  readonly capability: Capability;
  readonly guards: readonly GuardClass[];
}

export interface HttpRawBinding<P extends string = string, Auth = unknown>
  extends Binding<HttpRequest<Auth>, Response, PathParams<P>>, HttpRouteFields {
  readonly transport: 'http';
  readonly capability: Capability;
  readonly guards: readonly GuardClass[];
}

export interface HttpRoute extends HttpRouteFields {
  readonly key: string;
}

export type Maker<G> = <const P extends string, const O extends RouteOptionsFor<G> = {}>(
  path: P,
  options?: O,
) => HttpBinding<P, AuthOf<G, O>>;

export type RawMaker<G> = <const P extends string, const O extends RouteOptionsFor<G> = {}>(
  method: HttpMethod | '*',
  path: P,
  options?: O,
) => HttpRawBinding<P, AuthOf<G, O>>;

export interface RouteSource {
  readonly capability: Capability;
  readonly settings: HttpSettings;
}

function assertSkips(defaults: readonly GuardClass[], options: RouteOptions, key: string): void {
  const stray = (options.skip ?? []).find((guard) => !defaults.includes(guard));
  if (stray !== undefined) {
    throw new PieceDefinitionError(
      `route ${key}: skip names ${stray.name}, which is not a default guard of this token`,
    );
  }
}

function effectiveGuards(defaults: readonly GuardClass[], options: RouteOptions): GuardClass[] {
  const skipped = options.skip ?? [];
  const kept = defaults.filter((guard) => !skipped.includes(guard));
  const extra = (options.guards ?? []).filter((guard) => !kept.includes(guard));

  return [...kept, ...extra];
}

function assertPath(path: string, raw: boolean): void {
  if (!path.startsWith('/')) {
    throw new PieceDefinitionError(`route path "${path}" must start with /`);
  }

  const wildcard = path.split('/').findIndex((segment) => segment.startsWith('*'));
  const last = path.split('/').length - 1;

  if (wildcard !== -1 && (!raw || wildcard !== last)) {
    throw new PieceDefinitionError(
      `route path "${path}": a /*rest wildcard is allowed only last, on web.raw`,
    );
  }
}

export function makeRoute(
  source: RouteSource,
  method: HttpMethod | '*',
  path: string,
  options: RouteOptions,
  raw: boolean,
): HttpRoute {
  assertPath(path, raw);
  const key = `${method} ${path}`;
  assertSkips(source.settings.guards, options, key);
  const guards = effectiveGuards(source.settings.guards, options);
  assertNoGuardOverlap(guards, key);
  assertAdmission(guards, options.skip ?? [], options.meta ?? {}, key);
  assertIdempotent({ key, method, raw, guards, options, settings: source.settings });

  return Object.freeze({
    transport: 'http',
    key,
    capability: source.capability,
    guards,
    method,
    path,
    raw,
    options,
    settings: source.settings,
  });
}

export function isHttpRoute(binding: unknown): binding is HttpRoute {
  return Reflect.get(Object(binding), 'transport') === 'http' && Reflect.has(Object(binding), 'settings');
}
