import { byProject, byWorkspace } from '../../http/scopes.ts';
import type { Route } from '../../http/types.ts';
import { createProject } from './create.ts';
import { getProject } from './read.ts';

export const projectRoutes: Route[] = [
  { method: 'POST', path: '/v1/workspaces/:id/projects', idempotent: true, scope: byWorkspace(), handle: createProject },
  { method: 'GET', path: '/v1/projects/:id', scope: byProject(), handle: getProject },
];
