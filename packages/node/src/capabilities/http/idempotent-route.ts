import { idempotentMethodProblem, idempotentScopeProblem, MurmurError, type GuardClass } from 'murmur';
import type { z } from 'zod';

import { unwrapped } from '../../zod-unwrap.ts';
import type { HttpSettings, RouteOptions } from './binding.ts';
import { markIdempotent } from './settings.ts';

export interface IdempotentRoute {
  readonly key: string;
  readonly method: string;
  readonly raw: boolean;
  readonly guards: readonly GuardClass[];
  readonly options: RouteOptions;
  readonly settings: HttpSettings;
}

interface ScopePaths {
  readonly paths: readonly string[];
  readonly open: readonly string[];
}

const OPEN_TYPES: ReadonlySet<string> = new Set(['record', 'any', 'unknown', 'lazy', 'custom', 'pipe']);

function merged(all: readonly ScopePaths[]): ScopePaths {
  return {
    paths: [...new Set(all.flatMap((p) => p.paths))],
    open: [...new Set(all.flatMap((p) => p.open))],
  };
}

function branches(schema: z.ZodType): z.ZodType[] | undefined {
  const { def } = schema;
  const options: unknown = Reflect.get(def, 'options');

  if (def.type === 'union' && Array.isArray(options)) {
    return options as z.ZodType[];
  }

  if (def.type === 'intersection') {
    return [Reflect.get(def, 'left') as z.ZodType, Reflect.get(def, 'right') as z.ZodType];
  }

  return undefined;
}

function scopePaths(prefix: string, schema: z.ZodType): ScopePaths {
  const inner = unwrapped(schema);
  const shape: unknown = Reflect.get(inner.def, 'shape');
  const parts = branches(inner);

  if (inner.def.type === 'object' && shape !== undefined) {
    return merged(
      Object.entries(shape as Record<string, z.ZodType>).map(([key, field]) =>
        scopePaths(`${prefix}.${key}`, field),
      ),
    );
  }

  if (parts !== undefined) {
    return merged(parts.map((part) => scopePaths(prefix, part)));
  }

  return { paths: [prefix], open: OPEN_TYPES.has(inner.def.type) ? [prefix] : [] };
}

function authScope(guards: readonly GuardClass[]): ScopePaths {
  return merged(guards.map((guard) => scopePaths('auth', guard.model.schema)));
}

function refuse(message: string | undefined, code: string): void {
  if (message !== undefined) {
    throw new MurmurError(message, { code, retryable: false });
  }
}

export function assertIdempotent(route: IdempotentRoute): void {
  const { idempotent } = route.options;
  if (idempotent === undefined) {
    return;
  }

  refuse(idempotentMethodProblem(route.key, route.method, route.raw), 'idempotent-method');
  const auth = authScope(route.guards);

  refuse(idempotentScopeProblem(route.key, idempotent.scope, auth.paths, auth.open), 'idempotent-scope');
  markIdempotent(route.settings);
}
