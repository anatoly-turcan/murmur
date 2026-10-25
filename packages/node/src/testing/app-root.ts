import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface CallSite {
  getFileName(): string | null | undefined;
}

const MARKERS = ['murmur.config.ts', 'murmur.yaml'];
const FRAMEWORK_ROOT = fileURLToPath(new URL('../', import.meta.url));

function pathOf(file: string | null | undefined): string | undefined {
  if (typeof file !== 'string') {
    return undefined;
  }

  if (file.startsWith('file:')) {
    return fileURLToPath(file);
  }

  return isAbsolute(file) ? file : undefined;
}

function callSites(): readonly CallSite[] {
  const previous = Error.prepareStackTrace;
  const holder: { stack?: readonly CallSite[] } = {};
  Error.prepareStackTrace = (_error, sites) => sites;

  try {
    Error.captureStackTrace(holder, callSites);

    return holder.stack ?? [];
  } finally {
    Error.prepareStackTrace = previous;
  }
}

export function callerFile(): string | undefined {
  return callSites()
    .map((site) => pathOf(site.getFileName()))
    .find((file) => file !== undefined && !file.startsWith(FRAMEWORK_ROOT));
}

export function appRootOf(dir: string): string {
  if (MARKERS.some((marker) => existsSync(join(dir, marker)))) {
    return dir;
  }

  const parent = dirname(dir);

  return parent === dir ? process.cwd() : appRootOf(parent);
}

export function callerRoot(): string {
  const file = callerFile();

  return file === undefined ? process.cwd() : appRootOf(dirname(file));
}
