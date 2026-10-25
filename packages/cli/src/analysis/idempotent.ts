import { idempotentMethodProblem, idempotentScopeProblem } from 'murmur';

import type { IdempotentFact } from './extract.ts';
import type { StaticApp, StaticContract } from './static-app.ts';

interface ScopePaths {
  readonly paths: readonly string[];
  readonly open: readonly string[];
}

const MAX_DEPTH = 4;

function merged(all: readonly ScopePaths[]): ScopePaths {
  return {
    paths: [...new Set(all.flatMap((p) => p.paths))],
    open: [...new Set(all.flatMap((p) => p.open))],
  };
}

function fieldPaths(
  app: StaticApp,
  model: StaticContract,
  field: string,
  path: string,
  depth: number,
): ScopePaths {
  if (!(field in model.nested)) {
    return { paths: [path], open: [] };
  }

  const ref = model.nested[field];
  const nested = ref === null || ref === undefined ? null : app.contractIn(model.file, ref);

  if (nested?.kind !== 'model' || nested.fields === null || depth >= MAX_DEPTH) {
    return { paths: [path], open: [path] };
  }

  return modelPaths(app, nested, path, depth + 1);
}

function modelPaths(app: StaticApp, model: StaticContract, prefix: string, depth: number): ScopePaths {
  return merged(
    (model.fields ?? []).map((field) => fieldPaths(app, model, field, `${prefix}.${field}`, depth)),
  );
}

function guardPaths(app: StaticApp, wireName: string): ScopePaths {
  const contract = app.contracts.find((c) => c.wireName === wireName);
  const model = contract === undefined ? null : app.modelIn(contract);

  if (model === null || model.fields === null) {
    return { paths: [], open: ['auth'] };
  }

  return modelPaths(app, model, 'auth', 0);
}

export interface IdempotentRouteFacts {
  readonly key: string;
  readonly verb: string;
  readonly raw: boolean;
  readonly guards: readonly string[];
  readonly idempotent: IdempotentFact;
}

export function idempotentProblems(app: StaticApp, route: IdempotentRouteFacts): [string, string][] {
  const method = idempotentMethodProblem(route.key, route.verb, route.raw);
  if (method !== undefined) {
    return [['idempotent-method', method]];
  }

  if (route.idempotent.scope === null) {
    return [];
  }

  const auth = merged(route.guards.map((guard) => guardPaths(app, guard)));
  const scope = idempotentScopeProblem(route.key, route.idempotent.scope, auth.paths, auth.open);

  return scope === undefined ? [] : [['idempotent-scope', scope]];
}
