import { join } from 'node:path';

import type { PlannedFile } from './piece.ts';
import { render } from './template.ts';

const MODULE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\/[a-z][a-z0-9]*(-[a-z0-9]+)*)*$/;

export function libNameProblem(name: string): string | null {
  return MODULE_NAME.test(name)
    ? null
    : `"${name}": a lib module name is lower-case words separated by - or /, like money/round`;
}

function functionName(name: string): string {
  const last = name.split('/').at(-1) ?? name;

  return last.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function planLib(root: string, name: string): PlannedFile[] {
  const values = { fn: functionName(name), alias: `#lib/${name}` };

  return [
    { path: join(root, 'lib', `${name}.ts`), content: render('lib/module.ts.tmpl', values) },
    { path: join(root, 'lib', `${name}.test.ts`), content: render('lib/module.test.ts.tmpl', values) },
  ];
}
