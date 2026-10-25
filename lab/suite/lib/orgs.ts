import type { ApiResponse, Json, RequestOptions } from './client.ts';
import { need, uniqueName, type User } from './fixtures.ts';
import type { Id } from './ids.ts';

export type OrgRole = 'org_owner' | 'org_admin' | 'billing' | 'org_member';
export type Plan = 'free' | 'team' | 'business';

export const PLAN_LIMITS: Record<Plan, Json> = {
  free: { max_workspaces: 3, max_members_per_workspace: 10, max_webhooks_per_workspace: 2, api_requests_per_minute: 300 },
  team: { max_workspaces: 20, max_members_per_workspace: 100, max_webhooks_per_workspace: 10, api_requests_per_minute: 1200 },
  business: { max_workspaces: null, max_members_per_workspace: null, max_webhooks_per_workspace: 50, api_requests_per_minute: 6000 },
};

export async function createOrg(owner: User, body: Json = {}): Promise<Json> {
  return need(await owner.client.post('/v1/organizations', { name: uniqueName('Org'), ...body }), 201, 'create organization');
}

// PHASE2 names the member endpoints but not their body; the v1 member body ({email, role}) is tried first.
export async function postOrgMember(actor: User, orgId: Id, user: User, role: OrgRole, opts: RequestOptions = {}): Promise<ApiResponse> {
  const path = `/v1/organizations/${orgId}/members`;
  const byEmail = await actor.client.post(path, { email: user.email, role }, opts);
  if (byEmail.status !== 422 || !byEmail.text.includes('email')) return byEmail;

  return actor.client.post(path, { user_id: user.id, role }, opts);
}

export async function addOrgMember(actor: User, orgId: Id, user: User, role: OrgRole): Promise<Json> {
  return need(await postOrgMember(actor, orgId, user, role), 201, `add ${role} ${user.email} to organization ${orgId}`);
}

export async function setPlan(actor: User, orgId: Id, plan: Plan): Promise<Json> {
  return need(await actor.client.patch(`/v1/organizations/${orgId}`, { plan }), 200, `set plan ${plan}`);
}

export async function createWorkspaceIn(owner: User, orgId: Id, body: Json = {}): Promise<Json> {
  const payload = { name: uniqueName('Workspace'), organization_id: orgId, ...body };

  return need(await owner.client.post('/v1/workspaces', payload), 201, `create workspace in organization ${orgId}`);
}

export function memberUserId(item: Json): Id {
  return item?.user?.id ?? item?.user_id;
}

export async function orgMembers(actor: User, orgId: Id): Promise<Json[]> {
  return (await actor.client.pageAll(`/v1/organizations/${orgId}/members`, { limit: 100 })).items;
}

export async function orgRoleOf(actor: User, orgId: Id, user: User): Promise<string | undefined> {
  return (await orgMembers(actor, orgId)).find((m) => memberUserId(m) === user.id)?.role;
}
