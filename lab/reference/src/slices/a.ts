import { changeRole } from '../features/members/change-role.ts';
import { removeMember } from '../features/members/remove.ts';
import { seedReference } from '../features/seed/reference.ts';
import { deactivateMe } from '../features/users/deactivate.ts';
import { deleteWorkspace, restoreWorkspace } from '../features/workspaces/lifecycle.ts';
import { transferOwnership } from '../features/workspaces/transfer.ts';
import { updateWorkspace } from '../features/workspaces/update.ts';
import { byWorkspace } from '../http/scopes.ts';
import type { Slice } from './types.ts';

export const sliceA: Slice = {
  name: 'a',
  routes: [
    { method: 'PATCH', path: '/v1/workspaces/:id', scope: byWorkspace(), ifMatch: true, handle: updateWorkspace },
    { method: 'DELETE', path: '/v1/workspaces/:id', scope: byWorkspace(), ifMatch: true, handle: deleteWorkspace },
    { method: 'POST', path: '/v1/workspaces/:id/restore', scope: byWorkspace(), body: 'none', handle: restoreWorkspace },
    { method: 'POST', path: '/v1/workspaces/:id/transfer-ownership', scope: byWorkspace(), handle: transferOwnership },
    { method: 'PATCH', path: '/v1/workspaces/:id/members/:user_id', scope: byWorkspace(), handle: changeRole },
    { method: 'DELETE', path: '/v1/workspaces/:id/members/:user_id', scope: byWorkspace(), handle: removeMember },
    { method: 'DELETE', path: '/v1/users/me', handle: deactivateMe },
  ],
  jobHandlers: {},
  schedulerRules: [],
  seed: seedReference,
};
