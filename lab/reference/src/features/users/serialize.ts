import type { UserRow } from '../../domain/rows.ts';
import { iso } from '../../time/format.ts';

export function serializeUser(user: UserRow): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    timezone: user.timezone,
    digest_enabled: user.digest_enabled === 1,
    created_at: iso(user.created_at),
    updated_at: iso(user.updated_at),
  };
}

export function serializePublicUser(user: UserRow): Record<string, unknown> {
  return { id: user.id, name: user.name, created_at: iso(user.created_at) };
}
