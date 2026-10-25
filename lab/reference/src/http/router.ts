import { kindForSegment, type LegacyKind } from '../ids/legacy.ts';
import { legacyInteger, normalizeUuid } from '../ids/uuid.ts';
import type { Method, Params, Route } from './types.ts';

const METHODS: readonly Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

interface Segment {
  literal: string | null;
  param: string | null;
  kind: LegacyKind | null;
}

export interface LegacyParam {
  param: string;
  kind: LegacyKind;
  legacyId: number;
}

interface Matched {
  params: Params;
  legacy: LegacyParam[];
}

interface Compiled {
  route: Route;
  segments: Segment[];
  literals: number;
}

export type RouteMatch =
  | { kind: 'route'; route: Route; params: Params; legacy: LegacyParam[] }
  | { kind: 'method_not_allowed'; allowed: Method[] }
  | { kind: 'none' };

export interface Router {
  match(method: string, pathname: string): RouteMatch;
  routes: readonly Route[];
}

function compileSegment(part: string, previous: string | undefined): Segment {
  if (!part.startsWith(':')) return { literal: part, param: null, kind: null };

  return { literal: null, param: part.slice(1), kind: previous ? kindForSegment(previous) : null };
}

function compile(route: Route): Compiled {
  const parts = route.path.split('/').slice(1);
  const segments = parts.map((part, i) => compileSegment(part, parts[i - 1]));

  return { route, segments, literals: segments.filter((s) => s.literal !== null).length };
}

function bindParam(seg: Segment, raw: string, out: Matched): boolean {
  const uuid = normalizeUuid(raw);
  if (uuid !== null) {
    out.params[seg.param!] = uuid;

    return true;
  }
  const legacyId = seg.kind ? legacyInteger(raw) : null;
  if (legacyId === null) return false;
  out.params[seg.param!] = raw;
  out.legacy.push({ param: seg.param!, kind: seg.kind!, legacyId });

  return true;
}

function matchSegments(compiled: Compiled, parts: string[]): Matched | null {
  if (compiled.segments.length !== parts.length) return null;
  const out: Matched = { params: {}, legacy: [] };
  for (let i = 0; i < parts.length; i += 1) {
    const seg = compiled.segments[i];
    if (seg.literal !== null) {
      if (seg.literal !== parts[i]) return null;
      continue;
    }
    if (!bindParam(seg, parts[i], out)) return null;
  }

  return out;
}

function assertUnique(compiled: Compiled[]): void {
  const seen = new Set<string>();
  for (const c of compiled) {
    const key = `${c.route.method} ${c.segments.map((s) => s.literal ?? ':').join('/')}`;
    if (seen.has(key)) throw new Error(`duplicate route ${c.route.method} ${c.route.path}`);
    seen.add(key);
  }
}

type Candidate = Matched & { compiled: Compiled };

function best(matches: Candidate[]): Candidate | undefined {
  return matches.reduce<Candidate | undefined>(
    (top, m) => (!top || m.compiled.literals > top.compiled.literals ? m : top),
    undefined,
  );
}

export function createRouter(routes: readonly Route[]): Router {
  const compiled = routes.map(compile);
  assertUnique(compiled);

  return {
    routes,
    match(method, pathname) {
      const parts = pathname.split('/').slice(1);
      const matches = compiled.flatMap((c) => {
        const matched = matchSegments(c, parts);

        return matched ? [{ ...matched, compiled: c }] : [];
      });
      const sameMethod = best(matches.filter((m) => m.compiled.route.method === method));
      if (sameMethod) return { kind: 'route', route: sameMethod.compiled.route, params: sameMethod.params, legacy: sameMethod.legacy };
      if (matches.length === 0) return { kind: 'none' };
      const allowed = METHODS.filter((m) => matches.some((x) => x.compiled.route.method === m));

      return { kind: 'method_not_allowed', allowed };
    },
  };
}
