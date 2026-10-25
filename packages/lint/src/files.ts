import { statSync } from 'node:fs';

interface Cached<T> {
  readonly modified: number;
  readonly value: T;
}

export function modifiedAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

export function cacheByModified<T>(read: (path: string) => T): (path: string, modified: number) => T {
  const cache = new Map<string, Cached<T>>();

  return (path, modified) => {
    const cached = cache.get(path);
    if (cached?.modified === modified) {
      return cached.value;
    }

    const value = read(path);
    cache.set(path, { modified, value });

    return value;
  };
}
