import { copyFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export const DOC_PAGES = [
  'envelope',
  'piece-authoring',
  'capability-authoring',
  'ingress',
  'dev-protocol',
  'cli',
  'api-preview',
] as const;

export type DocPage = (typeof DOC_PAGES)[number];

const CLI_PACKAGE = join(import.meta.dirname, '..', '..');

function hasDocs(dir: string): boolean {
  return DOC_PAGES.every((page) => existsSync(join(dir, `${page}.md`)));
}

export function repoDocsDir(cliPackage: string = CLI_PACKAGE): string {
  return join(cliPackage, '..', '..', 'docs');
}

export function shippedDocsDir(cliPackage: string = CLI_PACKAGE): string {
  return join(cliPackage, 'docs');
}

export function resolveDocsDir(cliPackage: string = CLI_PACKAGE): string | null {
  return [repoDocsDir(cliPackage), shippedDocsDir(cliPackage)].find(hasDocs) ?? null;
}

function linkedFromApp(from: string, file: string): string | null {
  const linked = join(from, 'node_modules', '@murmur', 'cli', 'docs', basename(file));

  return existsSync(linked) && realpathSync(linked) === realpathSync(file) ? linked : null;
}

export function docRef(page: DocPage, from: string, docsDir: string | null = resolveDocsDir()): string {
  const file = docsDir === null ? null : join(docsDir, `${page}.md`);
  if (file === null || !existsSync(file)) {
    return `${page}.md`;
  }

  return relative(from, linkedFromApp(from, file) ?? file);
}

export function syncDocs(from: string, to: string): string[] {
  mkdirSync(to, { recursive: true });

  return DOC_PAGES.map((page) => {
    const target = join(to, `${page}.md`);
    copyFileSync(join(from, `${page}.md`), target);

    return target;
  });
}
