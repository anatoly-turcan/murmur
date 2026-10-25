import { byWorkspace } from '../../http/scopes.ts';
import type { Route } from '../../http/types.ts';
import { addMember } from './add.ts';
import { listMembers } from './list.ts';

export const memberRoutes: Route[] = [
  { method: 'GET', path: '/v1/workspaces/:id/members', list: true, scope: byWorkspace(), handle: listMembers },
  { method: 'POST', path: '/v1/workspaces/:id/members', idempotent: true, scope: byWorkspace(), handle: addMember },
];
