import {
  MurmurError,
  Rejection,
  type GuardClass,
  type GuardInput,
  type RequestClass,
  type RequestOptions,
} from 'murmur';

export type Requester = (contract: RequestClass, input: unknown, options: RequestOptions) => Promise<unknown>;

export type GuardBase = Omit<GuardInput, 'meta' | 'prior'>;

export interface GuardRun {
  readonly base: GuardBase;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly options: RequestOptions;
}

export type GuardOutcome =
  | { readonly passed: true; readonly auth: unknown }
  | { readonly passed: false; readonly rejection: Rejection; readonly auth: unknown };

function outputKeys(guard: GuardClass): string[] {
  const shape: unknown = Reflect.get(guard.model.schema, 'shape');

  return Object.keys(Object(shape));
}

function overlapMessage(first: GuardClass, second: GuardClass, keys: readonly string[], key: string): string {
  const fields = keys.map((name) => `"${name}"`).join(', ');

  return `guard-output-overlap: ${first.name} and ${second.name} both put ${fields} on req.auth (${key}); rename a field in one of the guard models`;
}

function overlapsWith(guards: readonly GuardClass[], at: number, key: string): string[] {
  const first = guards[at];
  if (first === undefined) {
    return [];
  }

  const keys = outputKeys(first);

  return guards.slice(at + 1).flatMap((second) => {
    const shared = outputKeys(second).filter((name) => keys.includes(name));
    if (shared.length === 0) {
      return [];
    }

    return [overlapMessage(first, second, shared, key)];
  });
}

export function assertNoGuardOverlap(guards: readonly GuardClass[], key: string): void {
  const [message] = guards.flatMap((_guard, at) => overlapsWith(guards, at, key));
  if (message !== undefined) {
    throw new MurmurError(message, { code: 'guard-output-overlap', retryable: false });
  }
}

function asRejection(value: unknown): Rejection | undefined {
  const parsed = Rejection.schema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }

  return parsed.data;
}

type Outputs = Map<GuardClass, unknown>;

function merged(outputs: Outputs): unknown {
  if (outputs.size === 0) {
    return undefined;
  }

  return Object.assign({}, ...outputs.values());
}

function priorOf(guard: GuardClass, outputs: Outputs): Record<string, unknown> {
  const earlier = [...guard.after, ...guard.optional].filter((g) => outputs.has(g));

  return Object.assign({}, ...earlier.map((g) => outputs.get(g)));
}

function ownMeta(guard: GuardClass, meta: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const keys = Object.keys(guard.meta.shape);

  return Object.fromEntries(Object.entries(meta).filter(([key]) => keys.includes(key)));
}

async function runFrom(
  guards: readonly GuardClass[],
  run: GuardRun,
  request: Requester,
  outputs: Outputs,
): Promise<GuardOutcome> {
  const guard = guards[outputs.size];
  if (guard === undefined) {
    return { passed: true, auth: merged(outputs) };
  }

  const input = { ...run.base, meta: ownMeta(guard, run.meta), prior: priorOf(guard, outputs) };
  const result = await request(guard, input, run.options);
  const rejection = asRejection(result);

  if (rejection !== undefined) {
    return { passed: false, rejection, auth: merged(outputs) };
  }

  outputs.set(guard, result);

  return runFrom(guards, run, request, outputs);
}

export function runGuards(
  guards: readonly GuardClass[],
  run: GuardRun,
  request: Requester,
): Promise<GuardOutcome> {
  return runFrom(guards, run, request, new Map());
}
