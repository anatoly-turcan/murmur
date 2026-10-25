import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserRow } from '../domain/rows.ts';
import type { Id } from '../ids/uuid.ts';

export type ActorType = 'user' | 'system' | 'api_key';

export interface AuditActor {
  type: ActorType;
  id: Id | null;
  name: string;
}

export interface AuditContext {
  actor: AuditActor;
  apiKeyId: Id | null;
  ip: string | null;
  requestId: string | null;
  timezone: string;
}

export interface RequestOrigin {
  user: UserRow | null;
  apiKeyId: Id | null;
  ip: string;
  requestId: string;
}

const SYSTEM: AuditContext = { actor: { type: 'system', id: null, name: 'system' }, apiKeyId: null, ip: null, requestId: null, timezone: 'UTC' };

const storage = new AsyncLocalStorage<AuditContext>();

function userActor(user: UserRow): AuditActor {
  return { type: 'user', id: user.id, name: user.name };
}

export function requestContext(origin: RequestOrigin): AuditContext {
  return {
    actor: origin.user ? userActor(origin.user) : { type: 'user', id: null, name: 'anonymous' },
    apiKeyId: origin.apiKeyId,
    ip: origin.ip,
    requestId: origin.requestId,
    timezone: origin.user?.timezone ?? 'UTC',
  };
}

export function withAuditContext<T>(context: AuditContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentAudit(): AuditContext {
  return storage.getStore() ?? SYSTEM;
}

// Registration has no caller yet: the account it creates becomes the actor of its own entries.
export function adoptActor(user: UserRow): void {
  const store = storage.getStore();
  if (!store) return;
  store.actor = userActor(user);
  store.timezone = user.timezone;
}
