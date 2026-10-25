import { q } from '../../http/query.ts';
import { byWorkspace } from '../../http/scopes.ts';
import type { Route } from '../../http/types.ts';
import { createWorkspace } from './create.ts';
import { listWorkspaces } from './list.ts';
import { getWorkspace } from './read.ts';

export const workspaceRoutes: Route[] = [
  { method: 'POST', path: '/v1/workspaces', idempotent: true, handle: createWorkspace },
  { method: 'GET', path: '/v1/workspaces', list: true, query: { include_deleted: q.bool(false) }, handle: listWorkspaces },
  { method: 'GET', path: '/v1/workspaces/:id', scope: byWorkspace(), handle: getWorkspace },
];
