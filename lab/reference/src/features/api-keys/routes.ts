import type { Route } from '../../http/types.ts';
import { createKey } from './create.ts';
import { listKeys } from './list.ts';
import { revokeKey } from './revoke.ts';

export const apiKeyRoutes: Route[] = [
  { method: 'GET', path: '/v1/users/me/api-keys', list: true, handle: listKeys },
  { method: 'POST', path: '/v1/users/me/api-keys', idempotent: true, handle: createKey },
  { method: 'DELETE', path: '/v1/users/me/api-keys/:id', handle: revokeKey },
];
