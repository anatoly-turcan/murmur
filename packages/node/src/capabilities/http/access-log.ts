import type { Log } from 'murmur';

import type { HttpSettings } from './binding.ts';

export interface AccessLine {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ms: number;
  readonly traceId: string;
  readonly auth: unknown;
}

export function authFields(auth: unknown): Readonly<Record<string, unknown>> {
  return (auth ?? {}) as Readonly<Record<string, unknown>>;
}

function extraFields(log: Log, settings: HttpSettings, line: AccessLine): Record<string, unknown> {
  try {
    return settings.log?.(authFields(line.auth)) ?? {};
  } catch (error) {
    log.error('the token log(auth) callback threw', { traceId: line.traceId, error });

    return {};
  }
}

export function logAccess(log: Log, settings: HttpSettings, line: AccessLine): void {
  const { auth: _auth, ...fields } = line;

  log.info('access', { ...fields, ...extraFields(log, settings, line) });
}
