import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { Options as SwcOptions } from '@swc/core';
import type { TransformOptions as EsbuildOptions } from 'esbuild';

export type Transform = (filename: string, source: string) => string;

export type TransformerName = 'swc' | 'esbuild';

export const TRANSFORMER_PACKAGES: Readonly<Record<TransformerName, string>> = {
  swc: '@swc/core',
  esbuild: 'esbuild',
};

export const SWC_OPTIONS = {
  swcrc: false,
  configFile: false,
  isModule: true,
  sourceMaps: 'inline',
  module: { type: 'es6' },
  jsc: {
    target: 'esnext',
    externalHelpers: true,
    parser: { syntax: 'typescript', decorators: true },
    transform: { decoratorVersion: '2023-11', useDefineForClassFields: true, verbatimModuleSyntax: true },
    experimental: { keepImportAttributes: true },
  },
} as const satisfies SwcOptions;

export const ESBUILD_OPTIONS = {
  loader: 'ts',
  format: 'esm',
  target: 'esnext',
  supported: { decorators: false },
  sourcemap: 'inline',
  tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } },
} as const satisfies EsbuildOptions;

export function transformerName(value: string | undefined): TransformerName {
  if (value === undefined || value === '' || value === 'swc') {
    return 'swc';
  }

  if (value === 'esbuild') {
    return 'esbuild';
  }

  throw new Error(`MURMUR_TRANSFORM=${value} is not a transformer: use swc (the default) or esbuild`);
}

async function swcTransform(): Promise<Transform> {
  try {
    const swc = (await import('@swc/core')).default;

    return (filename, source) => swc.transformSync(source, { ...SWC_OPTIONS, filename }).code;
  } catch (error) {
    throw new Error(
      "@swc/core could not load: check allowBuilds['@swc/core'] in pnpm-workspace.yaml and reinstall, or run murmur doctor",
      { cause: error },
    );
  }
}

async function esbuildTransform(): Promise<Transform> {
  try {
    const esbuild = (await import('esbuild')).default;

    return (filename, source) =>
      esbuild.transformSync(source, { ...ESBUILD_OPTIONS, sourcefile: filename }).code;
  } catch (error) {
    throw new Error('MURMUR_TRANSFORM=esbuild needs esbuild in the app: pnpm add -D esbuild@0.28.2', {
      cause: error,
    });
  }
}

export function loadTransform(name: TransformerName): Promise<Transform> {
  if (name === 'esbuild') {
    return esbuildTransform();
  }

  return swcTransform();
}

interface PackageManifest {
  readonly version?: string;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function installedManifest(from: string, name: string): string | null {
  try {
    return createRequire(from).resolve(`${name}/package.json`);
  } catch {
    return null;
  }
}

export function transformerBinary(name: TransformerName): string | null {
  const manifestPath = installedManifest(import.meta.url, TRANSFORMER_PACKAGES[name]);
  if (manifestPath === null) {
    return null;
  }

  for (const platformPackage of Object.keys(readManifest(manifestPath).optionalDependencies ?? {})) {
    const platformManifest = installedManifest(manifestPath, platformPackage);
    if (platformManifest !== null) {
      return `${platformPackage} ${readManifest(platformManifest).version ?? '?'}`;
    }
  }

  return null;
}
