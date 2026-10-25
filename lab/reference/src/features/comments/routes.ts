import { byComment, byTask } from '../../http/scopes.ts';
import type { Route } from '../../http/types.ts';
import { createComment } from './create.ts';
import { getComment } from './read.ts';

export const commentRoutes: Route[] = [
  { method: 'POST', path: '/v1/tasks/:id/comments', idempotent: true, scope: byTask(), handle: createComment },
  { method: 'GET', path: '/v1/comments/:id', scope: byComment(), handle: getComment },
];
