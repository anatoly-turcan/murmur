import { readFileSync, realpathSync } from 'node:fs';
import type { LoadHookSync, ResolveHookSync } from 'node:module';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Transform } from './transform.ts';

export const ROOT_PARAM = 'root';

const SWC_HELPERS = '@swc/helpers/';

const APP_EXTENSIONS = ['.ts', '.mts'];

export function appRootOf(registerUrl: string, cwd: string): string {
  return realpathSync(new URL(registerUrl).searchParams.get(ROOT_PARAM) ?? cwd);
}

function isUnderRoot(root: string, file: string): boolean {
  const path = relative(root, file);

  return path !== '' && !isAbsolute(path) && path.split(sep)[0] !== '..';
}

function isDependency(root: string, file: string): boolean {
  return relative(root, file).split(sep).includes('node_modules');
}

function hasAppExtension(file: string): boolean {
  return APP_EXTENSIONS.some((extension) => file.endsWith(extension));
}

export function isAppTs(url: string, root: string): boolean {
  if (!url.startsWith('file:')) {
    return false;
  }

  const file = fileURLToPath(url);

  return hasAppExtension(file) && isUnderRoot(root, file) && !isDependency(root, file);
}

export function loadWith(root: string, transform: Transform): LoadHookSync {
  return (url, context, nextLoad) => {
    if (!isAppTs(url, root)) {
      return nextLoad(url, context);
    }

    const filename = fileURLToPath(url);

    return {
      format: 'module',
      source: transform(filename, readFileSync(filename, 'utf8')),
      shortCircuit: true,
    };
  };
}

function isEmittedHelperImport(specifier: string, parentUrl: string | undefined, root: string): boolean {
  return specifier.startsWith(SWC_HELPERS) && parentUrl !== undefined && isAppTs(parentUrl, root);
}

export function resolveHelpersFor(root: string): ResolveHookSync {
  return (specifier, context, nextResolve) => {
    if (!isEmittedHelperImport(specifier, context.parentURL, root)) {
      return nextResolve(specifier, context);
    }

    return nextResolve(specifier, { ...context, parentURL: import.meta.url });
  };
}
