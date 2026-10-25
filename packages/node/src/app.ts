import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LoadError,
  type AnyCapabilityDefinition,
  type BusOptions,
  type DeliveryPolicyInput,
  type Transport,
} from 'murmur';

export interface SizeLimits {
  readonly ctxLargeTokens?: number;
  readonly ctxWarnTokens?: number;
  readonly ctxFailTokens?: number;
  readonly pieceLines?: number;
  readonly handlers?: number;
  readonly contextLines?: number;
}

export type AppCapabilities =
  | Readonly<Record<string, AnyCapabilityDefinition>>
  | readonly AnyCapabilityDefinition[];

export interface ProcessDefinition {
  readonly pieces: readonly string[];
  readonly jobs?: boolean;
}

export type AppProcesses = Readonly<Record<string, ProcessDefinition>>;

export interface AppDefinition {
  readonly name: string;
  readonly pieces?: string;
  readonly transport: Transport | (() => Transport | Promise<Transport>);
  readonly capabilities?: AppCapabilities;
  readonly policy?: DeliveryPolicyInput;
  readonly limits?: NonNullable<BusOptions['limits']> & SizeLimits;
  readonly observability?: { payloads?: boolean };
  readonly processes?: AppProcesses;
}

export const APP_FILE = 'murmur.config.ts';

export function defineApp(def: AppDefinition): AppDefinition {
  return def;
}

function isAppDefinition(value: unknown): value is AppDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'name') === 'string' &&
    Reflect.has(value, 'transport')
  );
}

export async function loadAppDefinition(root: string): Promise<AppDefinition> {
  const file = join(root, APP_FILE);

  await access(file).catch((cause: unknown) => {
    throw new LoadError(file, 'load', `${APP_FILE} not found`, { cause });
  });

  const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
  if (!isAppDefinition(module.default)) {
    throw new LoadError(file, 'load', `${APP_FILE} must default-export defineApp({ name, transport, ... })`);
  }

  return module.default;
}

export async function resolveTransport(app: AppDefinition): Promise<Transport> {
  return typeof app.transport === 'function' ? app.transport() : app.transport;
}
