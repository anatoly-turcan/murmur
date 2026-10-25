import { crApplied } from './cr.ts';
import { RUN_TOKEN } from './env.ts';
import { nextIp, send, type ApiResponse, type Json, type RequestOptions } from './http.ts';

// SUITE_CR call adaptation for the v1 tests (README "Change-request modes"). From CR-1 on, POST /v1/workspaces
// needs organization_id: a per-test steward user owns one business-plan organization per workspace creator, so
// v1 limits, buckets and visibility stay as v1 tests expect, and creators and transfer targets are enrolled as
// org_member (CR-1: "A workspace owner must be an org member").

interface Known {
  id: Json;
  email: string;
}

interface Steward {
  key: string;
  ip: string;
}

interface Generation {
  steward?: Promise<Steward>;
  orgs: Map<string, Promise<Json>>;
  workspaceOrg: Map<string, Json>;
}

const byKey = new Map<string, Known>();
const emailById = new Map<string, string>();
let generation: Generation = freshGeneration();
let counter = 0;

function freshGeneration(): Generation {
  return { orgs: new Map(), workspaceOrg: new Map() };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fixtureError(what: string, res: ApiResponse): Error {
  return new Error(`SUITE_CR org fixture: ${what} → ${res.status} ${res.text.slice(0, 400)}`);
}

function remember(secret: string, user: Known): void {
  byKey.set(secret, user);
  emailById.set(String(user.id), user.email);
}

async function createSteward(): Promise<Steward> {
  counter += 1;
  const ip = nextIp();
  const email = `steward.${RUN_TOKEN}.${counter}@example.com`;
  const reg = await send('POST', '/v1/users', { body: { email, name: 'Org Steward' }, ip });
  if (reg.status !== 201) throw fixtureError('register steward', reg);
  const key = reg.body.api_key.secret;
  const quiet = await send('PATCH', '/v1/users/me', { key, ip, body: { digest_enabled: false } });
  if (quiet.status !== 200) throw fixtureError('disable steward digest', quiet);

  return { key, ip };
}

function steward(): Promise<Steward> {
  generation.steward ??= createSteward();

  return generation.steward;
}

async function enroll(orgId: Json, user: Known): Promise<void> {
  const { key, ip } = await steward();
  const path = `/v1/organizations/${orgId}/members`;
  const byEmail = await send('POST', path, { key, ip, body: { email: user.email, role: 'org_member' } });
  if (byEmail.status !== 422) return;
  await send('POST', path, { key, ip, body: { user_id: user.id, role: 'org_member' } });
}

async function createOrgFor(user: Known): Promise<Json> {
  const { key, ip } = await steward();
  counter += 1;
  const created = await send('POST', '/v1/organizations', { key, ip, body: { name: `Org ${RUN_TOKEN} ${counter}` } });
  if (created.status !== 201) throw fixtureError('create organization', created);
  const orgId = created.body.id;
  const plan = await send('PATCH', `/v1/organizations/${orgId}`, { key, ip, body: { plan: 'business' } });
  if (plan.status !== 200) throw fixtureError('set business plan', plan);
  await enroll(orgId, user);

  return orgId;
}

function orgFor(user: Known): Promise<Json> {
  const memo = String(user.id);
  if (!generation.orgs.has(memo)) generation.orgs.set(memo, createOrgFor(user));

  return generation.orgs.get(memo)!;
}

interface Prepared {
  opts: RequestOptions;
  orgId?: Json;
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);

    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function rawJsonObject(opts: RequestOptions): Record<string, unknown> | undefined {
  if (typeof opts.rawBody !== 'string') return undefined;
  if (opts.contentType && !opts.contentType.startsWith('application/json')) return undefined;

  return parseJsonObject(opts.rawBody);
}

async function injectIntoRawBody(user: Known, opts: RequestOptions): Promise<Prepared> {
  const parsed = rawJsonObject(opts);
  if (!parsed || 'organization_id' in parsed) return { opts };
  const orgId = await orgFor(user);

  return { opts: { ...opts, rawBody: JSON.stringify({ ...parsed, organization_id: orgId }) }, orgId };
}

async function injectOrganization(opts: RequestOptions): Promise<Prepared> {
  const user = opts.key ? byKey.get(opts.key) : undefined;
  if (!user) return { opts };
  if (!isPlainObject(opts.body)) return injectIntoRawBody(user, opts);
  if ('organization_id' in opts.body) return { opts };
  const orgId = await orgFor(user);

  return { opts: { ...opts, body: { ...opts.body, organization_id: orgId } }, orgId };
}

async function enrollTransferTarget(workspaceId: string, opts: RequestOptions): Promise<void> {
  const orgId = generation.workspaceOrg.get(workspaceId);
  const target = isPlainObject(opts.body) ? opts.body.user_id : undefined;
  const email = emailById.get(String(target));
  if (orgId === undefined || email === undefined) return;
  await enroll(orgId, { id: target, email });
}

async function prepare(method: string, path: string, opts: RequestOptions): Promise<Prepared> {
  if (method === 'POST' && path === '/v1/workspaces') return injectOrganization(opts);
  const transfer = method === 'POST' ? /^\/v1\/workspaces\/([^/]+)\/transfer-ownership$/.exec(path) : null;
  if (transfer) await enrollTransferTarget(transfer[1], opts);

  return { opts };
}

function observe(method: string, path: string, opts: RequestOptions, res: ApiResponse, orgId: Json): void {
  if (method === 'POST' && path === '/__test/reset' && res.status === 204) generation = freshGeneration();
  if (method === 'POST' && path === '/v1/users' && res.status === 201) {
    remember(res.body.api_key.secret, { id: res.body.user.id, email: res.body.user.email });
  }
  const requester = opts.key ? byKey.get(opts.key) : undefined;
  if (method === 'POST' && path === '/v1/users/me/api-keys' && res.status === 201 && requester) remember(res.body.secret, requester);
  if (orgId !== undefined && res.status === 201) generation.workspaceOrg.set(String(res.body.id), orgId);
}

export async function adapt(method: string, path: string, opts: RequestOptions): Promise<ApiResponse> {
  const bare = path.split('?')[0];
  const prepared = crApplied('CR-1') ? await prepare(method, bare, opts) : { opts };
  const res = await send(method, path, prepared.opts);
  observe(method, bare, prepared.opts, res, prepared.orgId);

  return res;
}
