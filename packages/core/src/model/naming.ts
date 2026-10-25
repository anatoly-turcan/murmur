import { MurmurError } from './errors.ts';
import { isWireName } from './names.ts';

interface CallSite {
  getFileName(): string | null | undefined;
}

const STACK_DEPTH = 20;
const FRAMEWORK_ROOT = new URL('../', import.meta.url).href;
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

function captureCallSites(): readonly CallSite[] {
  const previousPrepare = Error.prepareStackTrace;
  const previousLimit = Error.stackTraceLimit;
  const holder: { stack?: readonly CallSite[] } = {};
  Error.prepareStackTrace = (_error: Error, sites: CallSite[]) => sites;
  Error.stackTraceLimit = Math.max(previousLimit, STACK_DEPTH);

  try {
    Error.captureStackTrace(holder, captureCallSites);

    return holder.stack ?? [];
  } finally {
    Error.prepareStackTrace = previousPrepare;
    Error.stackTraceLimit = previousLimit;
  }
}

function isAppFrame(file: string | null | undefined): file is string {
  return (
    typeof file === 'string' &&
    SOURCE_EXTENSION.test(file) &&
    !file.startsWith(FRAMEWORK_ROOT) &&
    !file.startsWith('node:')
  );
}

function toPath(file: string): string {
  if (!file.startsWith('file:')) {
    return file;
  }

  return new URL(file).pathname.split('/').map(decodeURIComponent).join('/');
}

export function definingFile(): string | undefined {
  const file = captureCallSites()
    .map((site) => site.getFileName())
    .find(isAppFrame);

  if (file === undefined) {
    return undefined;
  }

  return toPath(file);
}

export function domainOf(path: string): string | undefined {
  const parts = path.split('/');
  const dirs = parts.slice(0, -1);
  const stem = (parts.at(-1) ?? '').replace(SOURCE_EXTENSION, '');
  const piecesAt = dirs.lastIndexOf('pieces');
  const contractsAt = dirs.lastIndexOf('contracts');

  if (stem === 'contracts' && piecesAt > contractsAt) {
    return dirs.slice(piecesAt + 1).join('.');
  }

  if (contractsAt !== -1 && piecesAt === -1) {
    return [...dirs.slice(contractsAt + 1), stem].join('.');
  }

  return undefined;
}

function namingError(message: string): MurmurError {
  return new MurmurError(message, { code: 'invalid-name', retryable: false });
}

export function derivedWireName(file: string | undefined, className: string): string {
  if (file === undefined) {
    throw namingError(`cannot derive a wire name for ${className}: pass { name } explicitly`);
  }

  const domain = domainOf(file);
  if (domain === undefined) {
    throw namingError(
      `cannot derive a wire name for ${className} from ${file}: define it in contracts/ or pieces/<group>/contracts.ts, or pass { name }`,
    );
  }

  const name = `${domain}.${className}`;
  if (!isWireName(name)) {
    throw namingError(
      `cannot derive a wire name for ${className} from ${file}: "${name}" is not a valid name; rename the file or pass { name }`,
    );
  }

  return name;
}

export function checkedNameOverride(name: string | undefined): string | undefined {
  if (name !== undefined && !isWireName(name)) {
    throw namingError(
      `invalid contract name "${name}": use lowercase dot-separated segments, optionally ending in a ClassName (todos.removed, todos.CreateTodo)`,
    );
  }

  return name;
}
