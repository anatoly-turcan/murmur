import type { Json } from './client.ts';
import { NONEXISTENT_ID, type Id } from './ids.ts';
import { addMember, createComment, createProject, createTask, createWebhook, createWorkspace, getOk, registerUser, type User } from './fixtures.ts';

export type Slot = 'ws' | 'project' | 'task' | 'comment' | 'webhook' | 'delivery' | 'member' | 'user' | 'key';

export interface Endpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: Json;
  workspaceScoped: boolean;
}

export { NONEXISTENT_ID } from './ids.ts';

const ws = true;

export const ENDPOINTS: readonly Endpoint[] = [
  { method: 'GET', path: '/v1/users/me', workspaceScoped: false },
  { method: 'PATCH', path: '/v1/users/me', body: { name: 'Renamed' }, workspaceScoped: false },
  { method: 'DELETE', path: '/v1/users/me', workspaceScoped: false },
  { method: 'GET', path: '/v1/users/{user}', workspaceScoped: false },
  { method: 'GET', path: '/v1/users/me/api-keys', workspaceScoped: false },
  { method: 'POST', path: '/v1/users/me/api-keys', body: { name: 'ci' }, workspaceScoped: false },
  { method: 'DELETE', path: '/v1/users/me/api-keys/{key}', workspaceScoped: false },
  { method: 'POST', path: '/v1/workspaces', body: { name: 'Acme Ops' }, workspaceScoped: false },
  { method: 'GET', path: '/v1/workspaces', workspaceScoped: false },
  { method: 'GET', path: '/v1/workspaces/{ws}', workspaceScoped: ws },
  { method: 'GET', path: '/v1/workspaces/{ws}/members', workspaceScoped: ws },
  { method: 'GET', path: '/v1/workspaces/{ws}/projects', workspaceScoped: ws },
  { method: 'GET', path: '/v1/workspaces/{ws}/tasks', workspaceScoped: ws },
  { method: 'GET', path: '/v1/workspaces/{ws}/activity', workspaceScoped: ws },
  { method: 'GET', path: '/v1/workspaces/{ws}/search?q=login', workspaceScoped: ws },
  { method: 'GET', path: '/v1/workspaces/{ws}/webhooks', workspaceScoped: ws },
  { method: 'GET', path: '/v1/projects/{project}', workspaceScoped: ws },
  { method: 'GET', path: '/v1/projects/{project}/summary', workspaceScoped: ws },
  { method: 'GET', path: '/v1/projects/{project}/tasks', workspaceScoped: ws },
  { method: 'GET', path: '/v1/tasks/{task}', workspaceScoped: ws },
  { method: 'GET', path: '/v1/tasks/{task}/comments', workspaceScoped: ws },
  { method: 'GET', path: '/v1/comments/{comment}', workspaceScoped: ws },
  { method: 'GET', path: '/v1/webhooks/{webhook}', workspaceScoped: ws },
  { method: 'GET', path: '/v1/webhooks/{webhook}/deliveries', workspaceScoped: ws },
  { method: 'GET', path: '/v1/webhooks/{webhook}/deliveries/{delivery}', workspaceScoped: ws },
  { method: 'PATCH', path: '/v1/workspaces/{ws}', body: { name: 'Hijacked' }, workspaceScoped: ws },
  { method: 'POST', path: '/v1/workspaces/{ws}/members', body: { email: '{self_email}', role: 'member' }, workspaceScoped: ws },
  { method: 'PATCH', path: '/v1/workspaces/{ws}/members/{member}', body: { role: 'viewer' }, workspaceScoped: ws },
  { method: 'POST', path: '/v1/workspaces/{ws}/projects', body: { name: 'Intruder' }, workspaceScoped: ws },
  { method: 'POST', path: '/v1/workspaces/{ws}/webhooks', body: { url: 'http://127.0.0.1:9/x', events: ['*'] }, workspaceScoped: ws },
  { method: 'PATCH', path: '/v1/projects/{project}', body: { name: 'Hijacked' }, workspaceScoped: ws },
  { method: 'POST', path: '/v1/projects/{project}/restore', workspaceScoped: ws },
  { method: 'POST', path: '/v1/projects/{project}/tasks', body: { title: 'Intruder' }, workspaceScoped: ws },
  { method: 'PATCH', path: '/v1/tasks/{task}', body: { title: 'Hijacked' }, workspaceScoped: ws },
  { method: 'POST', path: '/v1/tasks/{task}/claim', workspaceScoped: ws },
  { method: 'POST', path: '/v1/tasks/{task}/restore', workspaceScoped: ws },
  { method: 'POST', path: '/v1/tasks/{task}/comments', body: { body: 'Intruder' }, workspaceScoped: ws },
  { method: 'PATCH', path: '/v1/comments/{comment}', body: { body: 'Hijacked' }, workspaceScoped: ws },
  { method: 'POST', path: '/v1/comments/{comment}/restore', workspaceScoped: ws },
  { method: 'PATCH', path: '/v1/webhooks/{webhook}', body: { active: false }, workspaceScoped: ws },
  { method: 'POST', path: '/v1/webhooks/{webhook}/deliveries/{delivery}/redeliver', workspaceScoped: ws },
  { method: 'POST', path: '/v1/workspaces/{ws}/transfer-ownership', body: { user_id: '{self_id}' }, workspaceScoped: ws },
  { method: 'DELETE', path: '/v1/comments/{comment}', workspaceScoped: ws },
  { method: 'DELETE', path: '/v1/tasks/{task}', workspaceScoped: ws },
  { method: 'DELETE', path: '/v1/webhooks/{webhook}', workspaceScoped: ws },
  { method: 'DELETE', path: '/v1/workspaces/{ws}/members/{member}', workspaceScoped: ws },
  { method: 'DELETE', path: '/v1/projects/{project}', workspaceScoped: ws },
  { method: 'DELETE', path: '/v1/workspaces/{ws}', workspaceScoped: ws },
  { method: 'POST', path: '/v1/workspaces/{ws}/restore', workspaceScoped: ws },
];

export function label(e: Endpoint): string {
  return `${e.method} ${e.path.replace(/\?.*$/, '')}`;
}

export function fill(path: string, ids: Partial<Record<Slot, Id>>): string {
  return path.replace(/\{(\w+)\}/g, (_, slot: string) => String(ids[slot as Slot] ?? NONEXISTENT_ID));
}

export function fillBody(body: Json, self: User): Json {
  if (body === undefined) return undefined;
  const text = JSON.stringify(body).replace('"{self_email}"', JSON.stringify(self.email)).replace('"{self_id}"', JSON.stringify(self.id));

  return JSON.parse(text);
}

export function slots(path: string): Slot[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as Slot);
}

export interface ObjectWorld {
  owner: User;
  member: User;
  outsider: User;
  ids: Record<Slot, Id>;
}

// A workspace with one of every object; the webhook URL refuses connections, which is fine because
// deliveries are listed as soon as the triggering request returns (SPEC 8.1).
export async function objectWorld(): Promise<ObjectWorld> {
  const owner = await registerUser({ name: 'Ana' });
  const member = await registerUser({ name: 'Bo' });
  const outsider = await registerUser({ name: 'Oz' });
  const workspace = await createWorkspace(owner);
  await createWorkspace(outsider);
  await addMember(owner, workspace.id, member, 'member');
  const hook = await createWebhook(owner, workspace.id, { url: 'http://127.0.0.1:9/hook', events: ['*'] });
  const project = await createProject(member, workspace.id);
  const task = await createTask(member, project.id, { title: 'Login redirect loop' });
  const comment = await createComment(member, task.id, 'login again');
  const deliveries = await getOk(owner, `/v1/webhooks/${hook.id}/deliveries`);
  if (!deliveries.data.length) throw new Error('fixture objectWorld: expected at least one delivery');

  return {
    owner,
    member,
    outsider,
    ids: {
      ws: workspace.id,
      project: project.id,
      task: task.id,
      comment: comment.id,
      webhook: hook.id,
      delivery: deliveries.data[0].id,
      member: member.id,
      user: member.id,
      key: member.keyId,
    },
  };
}
