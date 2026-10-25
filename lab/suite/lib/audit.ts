import assert from 'node:assert/strict';
import { TIMESTAMP_RE } from './assert.ts';
import type { ApiResponse, Json, Query } from './client.ts';
import { addMember, createProject, registerUser, type User } from './fixtures.ts';
import { assertPublicId, type Id } from './ids.ts';
import { createOrg, createWorkspaceIn, setPlan } from './orgs.ts';

export const AUDIT_ACTIONS = ['create', 'update', 'delete', 'restore', 'transfer', 'revoke', 'claim', 'deliver', 'send'];

export function requestId(res: ApiResponse): string {
  const id = res.headers.get('x-request-id');
  assert.ok(id, `mutating response must carry X-Request-Id: ${res.method} ${res.url} → ${res.status}`);

  return id;
}

export async function audit(actor: User, path: string, query: Query = {}): Promise<Json[]> {
  return (await actor.client.pageAll(path, { limit: 100, ...query })).items;
}

export function workspaceAudit(actor: User, wsId: Id, query: Query = {}): Promise<Json[]> {
  return audit(actor, `/v1/workspaces/${wsId}/audit`, query);
}

export function userOriginated(entries: readonly Json[]): Json[] {
  return entries.filter((e) => e.actor?.type !== 'system');
}

export function assertEntryShape(e: Json): void {
  assertPublicId(e.id, 'audit id');
  assert.match(e.occurred_at ?? '', TIMESTAMP_RE, 'occurred_at');
  assert.ok(['user', 'system', 'api_key'].includes(e.actor?.type), `actor.type: ${JSON.stringify(e.actor)}`);
  assert.ok('name' in e.actor && 'id' in e.actor, `actor needs id and name: ${JSON.stringify(e.actor)}`);
  for (const k of ['api_key_id', 'ip', 'request_id', 'organization_id', 'workspace_id', 'before', 'after']) assert.ok(k in e, `entry lacks ${k}: ${JSON.stringify(e)}`);
  assert.equal(typeof e.resource?.type, 'string', 'resource.type');
  assert.ok('id' in e.resource, 'resource.id');
  assert.ok(AUDIT_ACTIONS.includes(e.action), `action ${e.action}`);
  assert.ok(e.diff && typeof e.diff === 'object' && !Array.isArray(e.diff), 'diff must be an object');
  assert.equal(e.idempotent_replay, false);
}

// "actor: {type: user|api_key}": a key-authenticated request may name the user or the key; both must agree with the caller.
export function assertActorIs(e: Json, user: User): void {
  if (e.actor.type === 'api_key') assert.equal(e.actor.id, user.keyId, 'actor.id of an api_key actor is the key id');
  else {
    assert.equal(e.actor.type, 'user');
    assert.equal(e.actor.id, user.id, 'actor.id is the requesting user');
  }
  assert.equal(e.api_key_id, user.keyId, 'api_key_id is the key that made the request');
}

export interface AuditTeam {
  org: Json;
  ws: Json;
  project: Json;
  owner: User;
  admin: User;
  member: User;
  viewer: User;
}

// A business-plan organization so the CR-1 per-organization bucket never interferes with audit volume.
export async function auditTeam(): Promise<AuditTeam> {
  const owner = await registerUser({ name: 'Ana' });
  const [admin, member, viewer] = [await registerUser({ name: 'Adele' }), await registerUser({ name: 'Bo' }), await registerUser({ name: 'Vi' })];
  const org = await createOrg(owner);
  await setPlan(owner, org.id, 'business');
  const ws = await createWorkspaceIn(owner, org.id);
  await addMember(owner, ws.id, admin, 'admin');
  await addMember(owner, ws.id, member, 'member');
  await addMember(owner, ws.id, viewer, 'viewer');
  const project = await createProject(owner, ws.id);

  return { org, ws, project, owner, admin, member, viewer };
}
