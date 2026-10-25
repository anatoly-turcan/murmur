import { createHash } from 'node:crypto';

import type { Todo } from '../../../contracts/todos.ts';

export function etagOf(todo: Todo): string {
  const digest = createHash('sha1').update(JSON.stringify(todo)).digest('hex');

  return `"${digest.slice(0, 16)}"`;
}
