import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DevLock {
  readonly pid: number;
  readonly port: number;
  readonly host: string;
  readonly root: string;
  readonly startedAt: string;
  readonly protocol: 1;
}

export function lockFile(root: string): string {
  return join(root, '.murmur', 'dev.json');
}

export function readLock(root: string): DevLock | null {
  try {
    const lock = JSON.parse(readFileSync(lockFile(root), 'utf8')) as Partial<DevLock>;

    return typeof lock.pid === 'number' && typeof lock.port === 'number' && typeof lock.host === 'string'
      ? (lock as DevLock)
      : null;
  } catch {
    return null;
  }
}

export function writeLock(lock: DevLock): void {
  mkdirSync(join(lock.root, '.murmur'), { recursive: true });
  writeFileSync(lockFile(lock.root), `${JSON.stringify(lock, null, 2)}\n`);
}

export function removeLock(root: string, pid: number): void {
  if (readLock(root)?.pid === pid) {
    rmSync(lockFile(root), { force: true });
  }
}

export function baseUrl(lock: Pick<DevLock, 'host' | 'port'>): string {
  const host = lock.host.includes(':') ? `[${lock.host}]` : lock.host;

  return `http://${host}:${lock.port}`;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

export async function liveLock(root: string): Promise<DevLock | null> {
  const lock = readLock(root);
  if (lock === null || !isAlive(lock.pid)) {
    return null;
  }

  try {
    const response = await fetch(`${baseUrl(lock)}/api/health`, { signal: AbortSignal.timeout(1_500) });

    return response.ok ? lock : null;
  } catch {
    return null;
  }
}
