import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Target } from './target.ts';

function stampFile(target: Target): string {
  const dir = join(target.root, '.murmur', 'cache', 'hook');
  mkdirSync(dir, { recursive: true });

  return join(dir, `${target.key.replaceAll('/', '__')}.stamp`);
}

export async function settled(target: Target, debounceMs: number): Promise<boolean> {
  if (debounceMs === 0) {
    return true;
  }

  const file = stampFile(target);
  const token = crypto.randomUUID();
  writeFileSync(file, token);
  await sleep(debounceMs);

  return readFileSync(file, 'utf8') === token;
}
