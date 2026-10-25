import { matchesGlob } from 'node:path';

import type { StoredEnvelope } from '@murmur/dev-protocol';

export interface EnvFilter {
  readonly trace?: string | undefined;
  readonly piece?: string | undefined;
  readonly contract?: string | undefined;
}

function globMatch(value: string | undefined, glob: string | undefined): boolean {
  if (glob === undefined || glob === '') {
    return true;
  }

  return value !== undefined && (value === glob || matchesGlob(value, glob));
}

export function matchesEnv(stored: Pick<StoredEnvelope, 'envelope' | 'meta'>, filter: EnvFilter): boolean {
  const { envelope, meta } = stored;

  return (
    (filter.trace === undefined || envelope.traceId.startsWith(filter.trace)) &&
    globMatch(meta.piece, filter.piece) &&
    globMatch(envelope.name, filter.contract)
  );
}

export function filterOf(params: URLSearchParams): EnvFilter {
  const read = (key: string) => params.get(key) ?? undefined;

  return { trace: read('trace'), piece: read('piece'), contract: read('contract') };
}
