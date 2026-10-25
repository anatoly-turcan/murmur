import { ORG_ACTIVITY_QUERY, listOrgActivity } from '../features/organizations/activity.ts';
import { createOrganization } from '../features/organizations/create.ts';
import { deleteOrganization, restoreOrganization } from '../features/organizations/lifecycle.ts';
import { addOrgMember, changeOrgRole, listOrgMembers, removeOrgMember } from '../features/organizations/members.ts';
import { getOrganization, listOrganizations, ORG_LIST_QUERY } from '../features/organizations/read.ts';
import { transferOrganization } from '../features/organizations/transfer.ts';
import { updateOrganization } from '../features/organizations/update.ts';
import { getUsage } from '../features/organizations/usage.ts';
import { createOrgWebhook, listOrgWebhooks } from '../features/organizations/webhooks.ts';
import { listOrgWorkspaces } from '../features/organizations/workspaces.ts';
import type { Route } from '../http/types.ts';
import type { Slice } from './types.ts';

const ORG = '/v1/organizations/:id';

const routes: Route[] = [
  { method: 'POST', path: '/v1/organizations', idempotent: true, handle: createOrganization },
  { method: 'GET', path: '/v1/organizations', list: true, query: ORG_LIST_QUERY, handle: listOrganizations },
  { method: 'GET', path: ORG, handle: getOrganization },
  { method: 'PATCH', path: ORG, ifMatch: true, handle: updateOrganization },
  { method: 'DELETE', path: ORG, ifMatch: true, handle: deleteOrganization },
  { method: 'POST', path: `${ORG}/restore`, body: 'none', handle: restoreOrganization },
  { method: 'POST', path: `${ORG}/transfer-ownership`, handle: transferOrganization },
  { method: 'GET', path: `${ORG}/members`, list: true, handle: listOrgMembers },
  { method: 'POST', path: `${ORG}/members`, idempotent: true, handle: addOrgMember },
  { method: 'PATCH', path: `${ORG}/members/:user_id`, handle: changeOrgRole },
  { method: 'DELETE', path: `${ORG}/members/:user_id`, handle: removeOrgMember },
  { method: 'GET', path: `${ORG}/workspaces`, list: true, handle: listOrgWorkspaces },
  { method: 'GET', path: `${ORG}/usage`, handle: getUsage },
  { method: 'GET', path: `${ORG}/activity`, list: true, query: ORG_ACTIVITY_QUERY, handle: listOrgActivity },
  { method: 'GET', path: `${ORG}/webhooks`, list: true, handle: listOrgWebhooks },
  { method: 'POST', path: `${ORG}/webhooks`, idempotent: true, handle: createOrgWebhook },
];

export const sliceOrganizations: Slice = {
  name: 'organizations',
  routes,
  jobHandlers: {},
  schedulerRules: [],
};
