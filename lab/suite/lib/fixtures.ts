import { describe } from './assert.ts';
import { anonymous, Client, type ApiResponse, type Json, type Query } from './client.ts';
import { RUN_TOKEN } from './env.ts';
import type { Id } from './ids.ts';

export interface User {
  id: Id;
  email: string;
  name: string;
  timezone: string;
  key: string;
  keyId: Id;
  client: Client;
  raw: Json;
}

export interface Team {
  ws: Json;
  project: Json;
  owner: User;
  admin: User;
  member: User;
  viewer: User;
  admins: User[];
  members: User[];
  viewers: User[];
}

let counter = 0;

function next(): number {
  counter += 1;

  return counter;
}

export function uniqueEmail(label = 'user'): string {
  return `${label.toLowerCase().replace(/[^a-z0-9]+/g, '')}.${RUN_TOKEN}.${next()}@example.com`;
}

export function uniqueName(label: string): string {
  return `${label} ${RUN_TOKEN} ${next()}`;
}

export function need(res: ApiResponse, status: number, what: string): Json {
  if (res.status !== status) throw new Error(`fixture ${what} expected ${status}: ${describe(res)}`);

  return res.body;
}

export async function registerUser(opts: { name?: string; timezone?: string; email?: string } = {}): Promise<User> {
  const name = opts.name ?? `User ${next()}`;
  const email = opts.email ?? uniqueEmail(name);
  const body: Json = { email, name };
  if (opts.timezone) body.timezone = opts.timezone;
  const res = await anonymous().post('/v1/users', body);
  const out = need(res, 201, `register ${email}`);

  return {
    id: out.user.id,
    email: out.user.email,
    name: out.user.name,
    timezone: out.user.timezone,
    key: out.api_key.secret,
    keyId: out.api_key.id,
    client: new Client(out.api_key.secret),
    raw: out,
  };
}

export async function registerUsers(n: number, opts: { name?: string; timezone?: string } = {}, batch = 20): Promise<User[]> {
  const users: User[] = [];
  for (let i = 0; i < n; i += batch) {
    const size = Math.min(batch, n - i);
    const created = await Promise.all(
      Array.from({ length: size }, (_, j) => registerUser({ ...opts, name: opts.name ? `${opts.name} ${i + j + 1}` : undefined })),
    );
    users.push(...created);
  }

  return users;
}

export async function createWorkspace(owner: User, body: Json = {}): Promise<Json> {
  const payload = { name: uniqueName('Workspace'), ...body };

  return need(await owner.client.post('/v1/workspaces', payload), 201, 'create workspace');
}

export async function addMember(actor: User, wsId: Id, user: User, role: 'admin' | 'member' | 'viewer'): Promise<Json> {
  const res = await actor.client.post(`/v1/workspaces/${wsId}/members`, { email: user.email, role });

  return need(res, 201, `add ${role} ${user.email}`);
}

export async function createProject(actor: User, wsId: Id, body: Json = {}): Promise<Json> {
  const payload = { name: uniqueName('Project'), ...body };

  return need(await actor.client.post(`/v1/workspaces/${wsId}/projects`, payload), 201, 'create project');
}

export async function createTask(actor: User, projectId: Id, body: Json = {}): Promise<Json> {
  const payload = { title: uniqueName('Task'), ...body };

  return need(await actor.client.post(`/v1/projects/${projectId}/tasks`, payload), 201, 'create task');
}

export async function createTasks(actor: User, projectId: Id, n: number, body: (i: number) => Json = () => ({})): Promise<Json[]> {
  const out: Json[] = [];
  for (let i = 0; i < n; i += 1) out.push(await createTask(actor, projectId, body(i)));

  return out;
}

export async function createComment(actor: User, taskId: Id, body = 'Looks good to me.'): Promise<Json> {
  return need(await actor.client.post(`/v1/tasks/${taskId}/comments`, { body }), 201, 'create comment');
}

export async function createWebhook(actor: User, wsId: Id, body: Json): Promise<Json> {
  return need(await actor.client.post(`/v1/workspaces/${wsId}/webhooks`, body), 201, 'create webhook');
}

export async function patchOk(actor: User, path: string, body: Json): Promise<Json> {
  return need(await actor.client.patch(path, body), 200, `PATCH ${path}`);
}

export async function deleteOk(actor: User, path: string): Promise<void> {
  need(await actor.client.delete(path), 204, `DELETE ${path}`);
}

export async function postOk(actor: User, path: string, body?: Json, status = 200): Promise<Json> {
  return need(await actor.client.post(path, body), status, `POST ${path}`);
}

export async function getOk(actor: User, path: string, query?: Query): Promise<Json> {
  return need(await actor.client.get(path, query), 200, `GET ${path}`);
}

export async function activity(actor: User, wsId: Id, query: Query = {}): Promise<Json[]> {
  return (await actor.client.pageAll(`/v1/workspaces/${wsId}/activity`, { limit: 100, ...query })).items;
}

export async function team(spec: { admins?: number; members?: number; viewers?: number; ownerTz?: string; tz?: string } = {}): Promise<Team> {
  const owner = await registerUser({ name: 'Owner', timezone: spec.ownerTz ?? spec.tz });
  const ws = await createWorkspace(owner);
  const make = async (n: number, role: 'admin' | 'member' | 'viewer'): Promise<User[]> => {
    const users = await registerUsers(n, { name: role[0].toUpperCase() + role.slice(1), timezone: spec.tz });
    for (const u of users) await addMember(owner, ws.id, u, role);

    return users;
  };
  const admins = await make(spec.admins ?? 1, 'admin');
  const members = await make(spec.members ?? 1, 'member');
  const viewers = await make(spec.viewers ?? 1, 'viewer');
  const project = await createProject(owner, ws.id, { name: uniqueName('Website') });

  return { ws, project, owner, admins, members, viewers, admin: admins[0], member: members[0], viewer: viewers[0] };
}
