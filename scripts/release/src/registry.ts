import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function authKey(registry: string): string {
  const url = new URL(registry);
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;

  return `//${url.host}${path}:_authToken`;
}

export async function throwawayToken(registry: string): Promise<string | undefined> {
  const name = `murmur-release-${randomUUID().slice(0, 8)}`;
  const url = new URL(`-/user/org.couchdb.user:${name}`, registry.endsWith('/') ? registry : `${registry}/`);

  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      password: randomUUID(),
      email: `${name}@localhost`,
      type: 'user',
      roles: [],
    }),
  }).catch(() => null);

  if (response === null || !response.ok) {
    return undefined;
  }

  const body = (await response.json()) as { token?: unknown };

  return typeof body.token === 'string' ? body.token : undefined;
}

export function writeUserConfig(registry: string, token: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-release-'));
  const file = join(dir, 'npmrc');
  const lines = [`registry=${registry}`, ...(token === undefined ? [] : [`${authKey(registry)}=${token}`])];
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });

  return file;
}

export async function isPublished(registry: string, name: string, version: string): Promise<boolean> {
  const url = new URL(name.replace('/', '%2f'), registry.endsWith('/') ? registry : `${registry}/`);
  const response = await fetch(url, { headers: { accept: 'application/json' } }).catch(() => null);

  if (response === null || !response.ok) {
    return false;
  }

  const body = (await response.json()) as { versions?: Record<string, unknown> };

  return body.versions?.[version] !== undefined;
}
