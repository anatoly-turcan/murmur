import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliVersion } from '../version.ts';
import type { PlannedFile } from './piece.ts';
import { render } from './template.ts';

const FILES: readonly (readonly [string, string])[] = [
  ['package.json', 'app/package.json.tmpl'],
  ['pnpm-workspace.yaml', 'app/pnpm-workspace.yaml.tmpl'],
  ['tsconfig.json', 'app/tsconfig.json.tmpl'],
  ['capabilities/web/capability.ts', 'app/web-capability.ts.tmpl'],
  ['murmur.config.ts', 'app/murmur.config.ts.tmpl'],
  ['murmur.yaml', 'app/murmur.yaml.tmpl'],
  ['.gitignore', 'app/gitignore.tmpl'],
  ['.env.example', 'app/env.example.tmpl'],
  ['pieces/context.md', 'app/pieces-context.md.tmpl'],
  ['AGENTS.md', 'app/AGENTS.md.tmpl'],
  ['README.md', 'app/README.md.tmpl'],
];

function oxfmtConfig(): string {
  return readFileSync(fileURLToPath(import.meta.resolve('@murmur/lint/oxfmt')), 'utf8');
}

function npmrc(dir: string, registry: string | undefined): PlannedFile[] {
  return registry === undefined ? [] : [{ path: join(dir, '.npmrc'), content: `registry=${registry}\n` }];
}

function registrySection(registry: string | undefined, version: string): string {
  if (registry === undefined) {
    return '';
  }

  return [
    '',
    '## Registry',
    '',
    `Installs resolve from \`${registry}\` through \`.npmrc\`; the murmur packages are pinned to \`${version}\`.`,
    "pnpm reads only the app's own `.npmrc` (or your user config): keep the file when you move or copy the app.",
    '',
  ].join('\n');
}

export function planApp(dir: string, registry?: string): PlannedFile[] {
  const version = cliVersion();
  const values = { name: basename(dir), version, registry: registrySection(registry, version) };

  return [
    ...FILES.map(([path, template]) => ({ path: join(dir, path), content: render(template, values) })),
    { path: join(dir, '.oxlintrc.json'), content: render('app/oxlintrc.json.tmpl', {}) },
    { path: join(dir, '.oxfmtrc.json'), content: oxfmtConfig() },
    { path: join(dir, 'contracts', '.gitkeep'), content: '' },
    ...npmrc(dir, registry),
  ];
}
