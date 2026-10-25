import { listProjects, PROJECT_LIST_QUERY } from '../features/projects/list.ts';
import { deleteProject, restoreProject } from '../features/projects/lifecycle.ts';
import { projectSummary } from '../features/projects/summary.ts';
import { updateProject } from '../features/projects/update.ts';
import { claimTask } from '../features/tasks/claim.ts';
import { deleteTask, restoreTask } from '../features/tasks/lifecycle.ts';
import { PROJECT_TASKS_QUERY, WORKSPACE_TASKS_QUERY } from '../features/tasks/list-query.ts';
import { listProjectTasks, listWorkspaceTasks } from '../features/tasks/list.ts';
import { updateTask } from '../features/tasks/update.ts';
import { byProject, byTask, byWorkspace } from '../http/scopes.ts';
import type { Route } from '../http/types.ts';
import type { Slice } from './types.ts';

const projectRoutes: Route[] = [
  { method: 'GET', path: '/v1/workspaces/:id/projects', list: true, query: PROJECT_LIST_QUERY, scope: byWorkspace(), handle: listProjects },
  { method: 'PATCH', path: '/v1/projects/:id', ifMatch: true, scope: byProject(), handle: updateProject },
  { method: 'DELETE', path: '/v1/projects/:id', ifMatch: true, scope: byProject(), handle: deleteProject },
  { method: 'POST', path: '/v1/projects/:id/restore', body: 'none', scope: byProject(), handle: restoreProject },
  { method: 'GET', path: '/v1/projects/:id/summary', scope: byProject(), handle: projectSummary },
];

const taskRoutes: Route[] = [
  { method: 'GET', path: '/v1/projects/:id/tasks', list: true, query: PROJECT_TASKS_QUERY, scope: byProject(), handle: listProjectTasks },
  { method: 'GET', path: '/v1/workspaces/:id/tasks', list: true, query: WORKSPACE_TASKS_QUERY, scope: byWorkspace(), handle: listWorkspaceTasks },
  { method: 'PATCH', path: '/v1/tasks/:id', ifMatch: true, scope: byTask(), handle: updateTask },
  { method: 'DELETE', path: '/v1/tasks/:id', ifMatch: true, scope: byTask(), handle: deleteTask },
  { method: 'POST', path: '/v1/tasks/:id/claim', body: 'none', scope: byTask(), handle: claimTask },
  { method: 'POST', path: '/v1/tasks/:id/restore', body: 'none', scope: byTask(), handle: restoreTask },
];

export const sliceB: Slice = {
  name: 'b',
  routes: [...projectRoutes, ...taskRoutes],
  jobHandlers: {},
  schedulerRules: [],
};
