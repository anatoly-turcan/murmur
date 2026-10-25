import type { RequestClass } from 'murmur';

import type { HttpRoute } from './binding.ts';
import { coercePayload, type ZodIssue } from './coerce.ts';
import type { InputPart } from './errors.ts';
import type { Requester } from './guards.ts';
import { definedParams, hasBody, jsonBody, type InputSource } from './input.ts';
import { inputError, rootError } from './issues.ts';

const PART_ORDER: readonly InputPart[] = ['params', 'query', 'body'];

function timeoutOf(route: HttpRoute): { timeoutMs?: number } {
  if (route.options.timeoutMs === undefined) {
    return {};
  }

  return { timeoutMs: route.options.timeoutMs };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw rootError('body', 'invalid_type', 'expected a JSON object body');
}

interface Sources {
  readonly params: Record<string, string>;
  readonly query: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function partOf(issue: ZodIssue, sources: Sources, method: string): InputPart {
  const key = issue.path[0];
  const owner = PART_ORDER.toReversed().find(
    (part) => typeof key === 'string' && key in sources[part as keyof Sources],
  );

  return owner ?? (hasBody(method) ? 'body' : 'query');
}

function failure(issues: readonly ZodIssue[], sources: Sources, method: string): Error {
  const parts = issues.map((issue) => partOf(issue, sources, method));
  const first = PART_ORDER.find((part) => parts.includes(part)) ?? 'body';

  return inputError(
    first,
    issues.filter((_issue, at) => parts[at] === first),
  );
}

async function contractInput(contract: RequestClass, source: InputSource): Promise<unknown> {
  const sources = {
    params: definedParams(source.params),
    query: Object.fromEntries(source.query),
    body: asObject(await jsonBody(source)),
  };

  const coerced = await coercePayload(contract.input, sources);
  if (coerced.issues !== undefined) {
    throw failure(coerced.issues, sources, source.method);
  }

  return coerced.value;
}

export async function forward(
  source: InputSource,
  contract: RequestClass,
  route: HttpRoute,
  request: Requester,
): Promise<unknown> {
  const input = await contractInput(contract, source);

  return request(contract, input, timeoutOf(route));
}
