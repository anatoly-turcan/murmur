import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import type * as RegisterTransform from '@murmur/node/register/transform';

import { registerPath, registerUrl, resolveFromApp } from './app-exec-argv.ts';

export interface TransformerReport {
  readonly name: RegisterTransform.TransformerName | null;
  readonly package: string | null;
  readonly version: string | null;
  readonly binary: string | null;
  readonly registerUrl: string | null;
  readonly works: boolean;
  readonly error: string | null;
}

type TransformModule = typeof RegisterTransform;

type VersionOf = (from: string, name: string) => string | null;

const TRANSFORM_SPECIFIER = '@murmur/node/register/transform';

const PROBE_FILE = 'doctor-probe.ts';
const PROBE_SOURCE = [
  'function mark(_value: unknown, _context: ClassDecoratorContext): void {}',
  '@mark',
  'export class Probe {}',
  '',
].join('\n');

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function importTransformModule(root: string): Promise<TransformModule> {
  const file = resolveFromApp(root, TRANSFORM_SPECIFIER);

  return (await import(pathToFileURL(file).href)) as TransformModule;
}

async function probe(
  module: TransformModule,
  name: RegisterTransform.TransformerName,
): Promise<string | null> {
  try {
    const transform = await module.loadTransform(name);

    transform(PROBE_FILE, PROBE_SOURCE);

    return null;
  } catch (error) {
    return messageOf(error);
  }
}

async function inspect(
  root: string,
  selected: string | undefined,
  versionOf: VersionOf,
): Promise<TransformerReport> {
  const module = await importTransformModule(root);
  const name = module.transformerName(selected);
  const packageName = module.TRANSFORMER_PACKAGES[name];
  const error = await probe(module, name);

  return {
    name,
    package: packageName,
    version: versionOf(dirname(registerPath(root)), packageName),
    binary: module.transformerBinary(name),
    registerUrl: registerUrl(root),
    works: error === null,
    error,
  };
}

export async function transformerReport(
  root: string,
  selected: string | undefined,
  versionOf: VersionOf,
): Promise<TransformerReport> {
  try {
    return await inspect(root, selected, versionOf);
  } catch (error) {
    return {
      name: null,
      package: null,
      version: null,
      binary: null,
      registerUrl: null,
      works: false,
      error: messageOf(error),
    };
  }
}
