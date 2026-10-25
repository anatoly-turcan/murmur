import { matchesGlob } from 'node:path';

import { processNoPieceProblem } from 'murmur';

import type { AppDefinition } from '../app.ts';
import type { BootError, BootErrorCode } from '../types.ts';

export interface ProcessSelection {
  readonly globs: readonly string[] | undefined;
  readonly claimsJobs: boolean;
  readonly errors: readonly BootError[];
}

const EVERYTHING: ProcessSelection = { globs: undefined, claimsJobs: true, errors: [] };

function refused(code: BootErrorCode, message: string): ProcessSelection {
  return { globs: [], claimsJobs: false, errors: [{ phase: 'load', code, message }] };
}

function isGlobList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((glob) => typeof glob === 'string');
}

export function inProcess(id: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(id, glob));
}

export function selectProcess(
  app: AppDefinition,
  name: string | undefined,
  ids: readonly string[],
): ProcessSelection {
  if (name === undefined) {
    return EVERYTHING;
  }

  if (app.processes === undefined) {
    return refused(
      'process-unknown',
      `process \`${name}\` needs defineApp({ processes: { ${name}: { pieces: ['${name}/**'] } } }) in murmur.config.ts; without processes \`murmur start\` runs every piece`,
    );
  }

  const entry = Object.hasOwn(app.processes, name) ? app.processes[name] : undefined;
  if (entry === undefined) {
    const known = Object.keys(app.processes).toSorted().join(', ');

    return refused(
      'process-unknown',
      `process \`${name}\` is not in defineApp({ processes }); start one of ${known}`,
    );
  }

  if (!isGlobList(entry.pieces)) {
    return refused(
      'process-invalid',
      `processes.${name}.pieces must list piece id globs, e.g. ${name}: { pieces: ['${name}/**'], jobs: false }`,
    );
  }

  if (!ids.some((id) => inProcess(id, entry.pieces))) {
    return refused('process-invalid', processNoPieceProblem(name, entry.pieces, ids));
  }

  return { globs: entry.pieces, claimsJobs: entry.jobs !== false, errors: [] };
}
