import type { IngressTarget } from 'murmur';

import { isHttpRoute, type HttpRoute, type HttpSettings } from './binding.ts';

export interface RouteMatch {
  readonly kind: 'route';
  readonly target: IngressTarget;
  readonly route: HttpRoute;
  readonly params: Readonly<Record<string, string>>;
}

export type Matched =
  | RouteMatch
  | { readonly kind: 'method'; readonly allow: readonly string[] }
  | { readonly kind: 'none' };

export interface Router {
  readonly settings: HttpSettings;
  readonly routes: readonly HttpRoute[];
  match(method: string, pathname: string): Matched;
}

interface CompiledRoute {
  readonly target: IngressTarget;
  readonly route: HttpRoute;
  readonly segments: readonly string[];
}

interface Candidate {
  readonly compiled: CompiledRoute;
  readonly params: Record<string, string>;
  readonly rank: readonly number[];
}

const STATIC = 0;
const PARAM = 1;
const WILDCARD = 2;

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchWildcard(
  pattern: readonly string[],
  actual: readonly string[],
): Candidate['params'] | undefined {
  const fixed = pattern.slice(0, -1);
  const name = (pattern.at(-1) ?? '*').slice(1);

  if (actual.length <= fixed.length) {
    return undefined;
  }

  const params = matchFixed(fixed, actual.slice(0, fixed.length));
  if (params === undefined) {
    return undefined;
  }

  return { ...params, [name]: actual.slice(fixed.length).map(decode).join('/') };
}

function matchFixed(pattern: readonly string[], actual: readonly string[]): Candidate['params'] | undefined {
  if (pattern.length !== actual.length) {
    return undefined;
  }

  const params: Record<string, string> = {};
  for (const [index, segment] of pattern.entries()) {
    const value = actual[index] ?? '';
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decode(value);
    } else if (segment !== value) {
      return undefined;
    }
  }

  return params;
}

function rankOf(segments: readonly string[]): number[] {
  return segments.map((segment) => {
    if (segment.startsWith('*')) {
      return WILDCARD;
    }

    if (segment.startsWith(':')) {
      return PARAM;
    }

    return STATIC;
  });
}

function matchPath(compiled: CompiledRoute, actual: readonly string[]): Candidate | undefined {
  const { segments } = compiled;
  const wildcard = segments.at(-1)?.startsWith('*') === true;
  const params = wildcard ? matchWildcard(segments, actual) : matchFixed(segments, actual);

  if (params === undefined) {
    return undefined;
  }

  return { compiled, params, rank: rankOf(segments) };
}

function compareRanks(a: Candidate, b: Candidate): number {
  const length = Math.max(a.rank.length, b.rank.length);
  for (let at = 0; at < length; at += 1) {
    const difference = (a.rank[at] ?? WILDCARD) - (b.rank[at] ?? WILDCARD);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function servesMethod(route: HttpRoute, method: string): boolean {
  if (route.method === '*' || route.method === method) {
    return true;
  }

  return method === 'HEAD' && route.method === 'GET';
}

function allowedMethods(candidates: readonly Candidate[]): string[] {
  const methods = new Set<string>(candidates.map((candidate) => candidate.compiled.route.method));
  if (methods.has('GET')) {
    methods.add('HEAD');
  }

  return [...methods, 'OPTIONS'];
}

function choose(candidates: readonly Candidate[], method: string): Matched {
  const [best] = candidates.filter((c) => servesMethod(c.compiled.route, method)).toSorted(compareRanks);
  if (best !== undefined) {
    return { kind: 'route', target: best.compiled.target, route: best.compiled.route, params: best.params };
  }

  if (candidates.length > 0) {
    return { kind: 'method', allow: allowedMethods(candidates) };
  }

  return { kind: 'none' };
}

function compile(target: IngressTarget): CompiledRoute[] {
  const route = target.serve.binding;
  if (!isHttpRoute(route)) {
    return [];
  }

  return [{ target, route, segments: segmentsOf(route.path) }];
}

export function createRouter(targets: readonly IngressTarget[], settings: HttpSettings): Router {
  const compiled = targets.flatMap(compile);

  return {
    settings,
    routes: compiled.map((entry) => entry.route),
    match: (method, pathname) => {
      const actual = segmentsOf(pathname);
      const candidates = compiled.flatMap((entry) => matchPath(entry, actual) ?? []);

      return choose(candidates, method);
    },
  };
}
