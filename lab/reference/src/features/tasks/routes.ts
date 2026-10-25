import { byProject, byTask } from '../../http/scopes.ts';
import type { Route } from '../../http/types.ts';
import { createTask } from './create.ts';
import { getTask } from './read.ts';

export const taskRoutes: Route[] = [
  { method: 'POST', path: '/v1/projects/:id/tasks', idempotent: true, scope: byProject(), handle: createTask },
  { method: 'GET', path: '/v1/tasks/:id', scope: byTask(), handle: getTask },
];
