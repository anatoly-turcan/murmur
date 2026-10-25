import { extname, join } from 'node:path';

export function siblingModule(meta: ImportMeta, name: string): string {
  return join(meta.dirname, `${name}${extname(meta.filename)}`);
}
