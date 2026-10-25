import type { Route } from '../../http/types.ts';
import { patchMe, getMe } from './me.ts';
import { getUser } from './read.ts';
import { register } from './register.ts';

export const userRoutes: Route[] = [
  { method: 'POST', path: '/v1/users', auth: 'none', idempotent: true, idempotencyScope: 'ip', handle: register },
  { method: 'GET', path: '/v1/users/me', handle: getMe },
  { method: 'PATCH', path: '/v1/users/me', handle: patchMe },
  { method: 'GET', path: '/v1/users/:id', handle: getUser },
];
