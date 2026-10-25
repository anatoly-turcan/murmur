import { join } from 'node:path';

import { pieceDir } from './names.ts';
import { render, yamlScalar } from './template.ts';

export interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

function titleOf(id: string): string {
  return id.split('/').at(-1) ?? id;
}

export function groupContextFile(root: string, id: string): PlannedFile {
  return {
    path: join(pieceDir(root, id), 'context.md'),
    content: render('piece/group-context.md.tmpl', { title: yamlScalar(titleOf(id)), id }),
  };
}
