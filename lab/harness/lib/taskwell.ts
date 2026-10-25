import { Agent, request } from 'node:http'
import { searchTerms, type Identity, type Pool, type WorkspaceData } from './perf.ts'

export interface Response {
  status: number
  json: unknown
}

export interface SeedUser {
  email: string
  api_key: string
  workspace_ids: Array<string | number>
}

type Json = Record<string, unknown>

const agent = new Agent({ keepAlive: true, maxSockets: 8 })

export function call(baseUrl: string, method: string, path: string, key?: string, body?: unknown): Promise<Response> {
  const url = new URL(path, baseUrl)
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const headers: Record<string, string> = { 'x-forwarded-for': `10.250.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}` }
  if (key) headers.authorization = `Bearer ${key}`
  if (payload) headers['content-type'] = 'application/json'

  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, agent }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, json: text ? safeParse(text) : null })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function expect(res: Promise<Response>, ok: number[], what: string): Promise<Json> {
  const r = await res
  if (!ok.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`)

  return (r.json ?? {}) as Json
}

export async function seedReference(baseUrl: string): Promise<SeedUser[]> {
  await expect(call(baseUrl, 'POST', '/__test/reset'), [204, 200], 'reset')
  const seeded = await expect(call(baseUrl, 'POST', '/__test/seed', undefined, { profile: 'reference' }), [200], 'seed')

  return seeded.users as SeedUser[]
}

async function listAll(baseUrl: string, path: string, key: string, maxPages = 50): Promise<Json[]> {
  const items: Json[] = []
  let cursor: string | null = null
  for (let page = 0; page < maxPages; page += 1) {
    const sep = path.includes('?') ? '&' : '?'
    const body = await expect(call(baseUrl, 'GET', cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path, key), [200], path)
    items.push(...((body.data as Json[]) ?? []))
    cursor = (body.next_cursor as string | null) ?? null
    if (!cursor) break
  }

  return items
}

async function mintKeys(baseUrl: string, user: SeedUser, count: number): Promise<string[]> {
  const keys = [user.api_key]
  for (let i = keys.length; i < count; i += 1) {
    const r = await call(baseUrl, 'POST', '/v1/users/me/api-keys', user.api_key, { name: `load-${i}` })
    const json = (r.json ?? {}) as Json
    const secret = (json.secret ?? (json.api_key as Json | undefined)?.secret) as string | undefined
    if (r.status !== 201 || !secret) break
    keys.push(secret)
  }

  return keys
}

async function identity(baseUrl: string, user: SeedUser, keysPerUser: number): Promise<Identity> {
  const workspaces = await listAll(baseUrl, '/v1/workspaces?limit=100', user.api_key)
  const roles = Object.fromEntries(workspaces.map((w) => [String(w.id), String(w.my_role)]))

  return { email: user.email, keys: await mintKeys(baseUrl, user, keysPerUser), roles }
}

interface Discovered {
  workspace: WorkspaceData
  titles: string[]
  summaries: Array<{ id: string; tasks: number }>
}

async function exploreWorkspace(baseUrl: string, id: string, keys: string[], maxProjects: number): Promise<Discovered> {
  const key = (i: number) => keys[i % keys.length] as string
  const projects = (await listAll(baseUrl, `/v1/workspaces/${id}/projects?limit=100`, key(0))).map((p) => String(p.id))
  const tasks: string[] = []
  const titles: string[] = []
  const summaries: Discovered['summaries'] = []
  for (const [i, pid] of projects.entries()) {
    const summary = await call(baseUrl, 'GET', `/v1/projects/${pid}/summary`, key(i))
    const total = Number(((summary.json as Json | null)?.task_counts as Json | undefined)?.total ?? 0)
    summaries.push({ id: pid, tasks: total })
    if (i >= maxProjects) continue
    const page = await call(baseUrl, 'GET', `/v1/projects/${pid}/tasks?limit=100`, key(i + 1))
    for (const t of ((page.json as Json | null)?.data as Json[] | undefined) ?? []) {
      tasks.push(String(t.id))
      titles.push(String(t.title ?? ''))
    }
  }

  return { workspace: { id, projects, tasks }, titles, summaries }
}

export async function discover(baseUrl: string, users: SeedUser[], keysPerUser = 20, maxProjects = 20): Promise<Pool> {
  const identities: Identity[] = []
  for (const user of users) identities.push(await identity(baseUrl, user, keysPerUser))
  const workspaceIds = [...new Set(identities.flatMap((i) => Object.keys(i.roles)))]
  const found: Discovered[] = []
  for (const id of workspaceIds) {
    const owner = identities.find((i) => i.roles[id] !== undefined) as Identity
    found.push(await exploreWorkspace(baseUrl, id, owner.keys, maxProjects))
  }
  const best = found
    .flatMap((d) => d.summaries.map((s) => ({ ...s, workspace_id: d.workspace.id })))
    .reduce<Pool['summary_project']>((top, s) => (!top || s.tasks > top.tasks ? s : top), null)

  return {
    identities,
    workspaces: found.map((d) => d.workspace),
    summary_project: best,
    search_terms: searchTerms(found.flatMap((d) => d.titles)),
  }
}
