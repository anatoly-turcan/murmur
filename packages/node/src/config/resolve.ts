import { ContractViolationError, parseSchema, type PiecePolicy, type Schema, type SchemaIssue } from 'murmur';
import { z } from 'zod';

import { capabilityEnvName, pieceEnvName, sharedEnvName } from './env-names.ts';
import type { Env, RawMap, RawValue, YamlConfig } from './sources.ts';

export type ConfigSource = 'env' | 'yaml' | 'default';
type Path = readonly PropertyKey[];

export interface ConfigInputs {
  readonly env: Env;
  readonly yaml: YamlConfig;
}

export interface ResolvedConfig {
  readonly config: Readonly<Record<string, unknown>>;
  readonly sources: Readonly<Record<string, ConfigSource>>;
  readonly errors: readonly ContractViolationError[];
}

const UNDECODABLE = Symbol('undecodable');

const positive = z.number().int().positive();
const policySchema = z.strictObject({
  concurrency: positive.optional(),
  timeoutMs: positive.optional(),
  retry: z
    .strictObject({
      maxAttempts: positive.optional(),
      baseMs: z.number().nonnegative().optional(),
      maxMs: z.number().nonnegative().optional(),
      jitter: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

function decodeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return UNDECODABLE;
  }
}

function issuePath(issue: SchemaIssue): PropertyKey[] {
  return [...(issue.path ?? [])];
}

function decodeAt(value: unknown, path: Path): unknown {
  if (path.length === 0) {
    return typeof value === 'string' ? decodeJson(value) : UNDECODABLE;
  }

  if (typeof value !== 'object' || value === null) {
    return UNDECODABLE;
  }

  const [head, ...rest] = path;
  const container = value as Record<PropertyKey, unknown>;

  if (head === undefined || !(head in container)) {
    return UNDECODABLE;
  }

  const decoded = decodeAt(container[head], rest);
  if (decoded === UNDECODABLE) {
    return UNDECODABLE;
  }

  const copy = Array.isArray(value) ? [...value] : { ...container };

  return Object.assign(copy, { [head]: decoded });
}

function decodeIssues(raw: unknown, issues: readonly SchemaIssue[]): unknown {
  let decoded = UNDECODABLE as unknown;
  for (const issue of issues) {
    const next = decodeAt(decoded === UNDECODABLE ? raw : decoded, issuePath(issue));
    if (next !== UNDECODABLE) {
      decoded = next;
    }
  }

  return decoded;
}

function prefixed(issues: readonly SchemaIssue[], path: Path): SchemaIssue[] {
  return issues.map((issue) => ({ ...issue, path: [...path, ...issuePath(issue)] }));
}

export async function coerce(
  name: string,
  schema: Schema,
  raw: RawValue | undefined,
  path: Path = [],
): Promise<unknown> {
  const first = await parseSchema(schema, raw);
  if (first.issues === undefined) {
    return first.value;
  }

  const retry = decodeIssues(raw, first.issues);
  if (retry === UNDECODABLE) {
    throw new ContractViolationError(name, 'config', prefixed(first.issues, path));
  }

  const second = await parseSchema(schema, retry);
  if (second.issues === undefined) {
    return second.value;
  }

  throw new ContractViolationError(name, 'config', prefixed(second.issues, path));
}

function rawPieceValue(
  id: string,
  key: string,
  inputs: ConfigInputs,
): { raw: RawValue | undefined; source: ConfigSource } {
  const candidates: [ConfigSource, RawValue | undefined][] = [
    ['env', inputs.env[pieceEnvName(id, key)]],
    ['env', inputs.env[sharedEnvName(key)]],
    ['yaml', inputs.yaml.pieces[id]?.[key]],
    ['yaml', inputs.yaml.shared[key]],
  ];
  const found = candidates.find(([, raw]) => raw !== undefined);

  return found === undefined ? { raw: undefined, source: 'default' } : { raw: found[1], source: found[0] };
}

type KeyOutcome =
  | { readonly key: string; readonly source: ConfigSource; readonly value: unknown }
  | { readonly key: string; readonly source: ConfigSource; readonly error: ContractViolationError };

async function resolveKey(
  id: string,
  key: string,
  schema: Schema,
  inputs: ConfigInputs,
): Promise<KeyOutcome> {
  const { raw, source } = rawPieceValue(id, key, inputs);

  try {
    return { key, source, value: await coerce(`${id}.config`, schema, raw, [key]) };
  } catch (error) {
    if (!(error instanceof ContractViolationError)) {
      throw error;
    }

    return { key, source, error };
  }
}

export async function resolvePieceConfig(
  id: string,
  schemas: Readonly<Record<string, Schema>>,
  inputs: ConfigInputs,
): Promise<ResolvedConfig> {
  const outcomes = await Promise.all(
    Object.entries(schemas).map(([key, schema]) => resolveKey(id, key, schema, inputs)),
  );

  return {
    config: Object.freeze(
      Object.fromEntries(outcomes.flatMap((o) => ('value' in o ? [[o.key, o.value]] : []))),
    ),
    sources: Object.freeze(Object.fromEntries(outcomes.map((o) => [o.key, o.source]))),
    errors: outcomes.flatMap((o) => ('error' in o ? [o.error] : [])),
  };
}

export function schemaKeys(schema: Schema | undefined): string[] {
  try {
    const json = schema === undefined ? undefined : z.toJSONSchema(schema, { io: 'input' });
    const properties = json?.['properties'];

    return typeof properties === 'object' && properties !== null ? Object.keys(properties) : [];
  } catch {
    return [];
  }
}

export const INGRESS_SWITCH = 'enabled';
export const HEALTHZ_SWITCH = 'healthz';

const ingressSwitch = z.boolean().default(true);
const healthzSwitch = z.boolean().default(false);

function rawCapabilityConfig(
  name: string,
  keys: readonly string[],
  inputs: ConfigInputs,
  reserved: readonly string[],
): RawMap {
  const fromYaml = inputs.yaml.capabilities[name] ?? {};
  const all = [...new Set([...keys, ...Object.keys(fromYaml)])].filter((key) => !reserved.includes(key));
  const entries = all.flatMap((key) => {
    const raw = inputs.env[capabilityEnvName(name, key)] ?? fromYaml[key];

    return raw === undefined ? [] : [[key, raw] as const];
  });

  return Object.fromEntries(entries);
}

export async function resolveCapabilityConfig(
  name: string,
  schema: Schema | undefined,
  inputs: ConfigInputs,
  reserved: readonly string[] = [],
): Promise<unknown> {
  if (schema === undefined) {
    return undefined;
  }

  return coerce(`${name}.config`, schema, rawCapabilityConfig(name, schemaKeys(schema), inputs, reserved));
}

export async function resolveIngressEnabled(name: string, inputs: ConfigInputs): Promise<boolean> {
  const raw =
    inputs.env[capabilityEnvName(name, INGRESS_SWITCH)] ?? inputs.yaml.capabilities[name]?.[INGRESS_SWITCH];

  return (await coerce(`${name}.config`, ingressSwitch, raw, [INGRESS_SWITCH])) as boolean;
}

export async function resolveHealthz(name: string, inputs: ConfigInputs): Promise<boolean> {
  const raw =
    inputs.env[capabilityEnvName(name, HEALTHZ_SWITCH)] ?? inputs.yaml.capabilities[name]?.[HEALTHZ_SWITCH];

  return (await coerce(`${name}.config`, healthzSwitch, raw, [HEALTHZ_SWITCH])) as boolean;
}

export async function resolvePolicy(id: string, raw: RawValue | undefined): Promise<PiecePolicy> {
  if (raw === undefined) {
    return {};
  }

  return (await coerce(`${id}.$policy`, policySchema, raw, ['$policy'])) as PiecePolicy;
}
