import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function pnpmCacheRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (env['XDG_CACHE_HOME'] !== undefined) {
    return join(env['XDG_CACHE_HOME'], 'pnpm');
  }

  if (platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'pnpm');
  }

  if (platform === 'win32') {
    return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'pnpm-cache');
  }

  return join(home, '.cache', 'pnpm');
}

export function registryCacheName(registry: string): string {
  const url = new URL(registry);

  return [encodeURIComponent(url.protocol), url.hostname, ...(url.port === '' ? [] : [url.port])].join('+');
}

function children(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function cachedMetadataDirs(registry: string, cacheRoot: string): string[] {
  const name = registryCacheName(registry);
  const stores = children(cacheRoot)
    .filter((entry) => /^v\d+$/.test(entry))
    .flatMap((version) =>
      children(join(cacheRoot, version))
        .filter((entry) => entry.startsWith('metadata'))
        .map((entry) => join(cacheRoot, version, entry)),
    );

  return stores.filter((store) => children(store).includes(name)).map((store) => join(store, name));
}

export function metadataCacheWarning(registry: string, cacheRoot: string): string {
  const found = cachedMetadataDirs(registry, cacheRoot);
  const dirs = found.length > 0 ? found : [join(cacheRoot, 'v*', 'metadata*', registryCacheName(registry))];

  return [
    `warning: pnpm caches registry metadata per registry URL. If a version just published was installed from ${registry}`,
    'before (a wiped or recreated registry), pnpm keeps resolving the old tarball until this cache is removed:',
    ...dirs.map((dir) => `  rm -rf '${dir}'`),
  ].join('\n');
}
