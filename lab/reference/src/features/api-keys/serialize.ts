import type { ApiKeyRow } from '../../domain/rows.ts';
import { iso, isoOrNull } from '../../time/format.ts';

export function serializeApiKey(key: ApiKeyRow, secret?: string): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    ...(secret === undefined ? {} : { secret }),
    created_at: iso(key.created_at),
    last_used_at: isoOrNull(key.last_used_at),
    revoked_at: isoOrNull(key.revoked_at),
  };
}
