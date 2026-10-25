import { existsSync, globSync } from 'node:fs';
import { join } from 'node:path';

import { child, identifierName, type Node, parse, signaturesOnly } from './ast.ts';
import { readSource } from './source-checks.ts';
import type { FolderNode, Repo } from './types.ts';

export const LIB_ALIAS = '#lib/';

const TYPE_DECLARATIONS = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration']);

export interface LibModule {
  readonly id: string;
  readonly alias: string;
  readonly file: string;
}

export interface LibUse extends LibModule {
  readonly names: readonly string[];
  readonly signatures: string;
}

function moduleOf(root: string, name: string): LibModule {
  return { id: `lib/${name}`, alias: `${LIB_ALIAS}${name}`, file: join(root, 'lib', `${name}.ts`) };
}

export function libModules(root: string): LibModule[] {
  return globSync('lib/**/*.ts', { cwd: root })
    .map((path) => path.split('\\').join('/'))
    .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.d.ts'))
    .map((path) => moduleOf(root, path.slice('lib/'.length, -'.ts'.length)))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

export function libModule(root: string, id: string): LibModule | null {
  const name = id.replace(/^lib\//, '').replace(/\.ts$/, '');
  const module = moduleOf(root, name);

  return existsSync(module.file) ? module : null;
}

function exportedOf(statement: Node): string[] {
  const declaration = child(statement, 'declaration');
  if (declaration === undefined) {
    return ((statement['specifiers'] as Node[] | undefined) ?? []).flatMap(
      (s) => identifierName(child(s, 'exported')) ?? [],
    );
  }

  if (declaration.type === 'VariableDeclaration') {
    return (declaration['declarations'] as Node[]).flatMap((d) => identifierName(child(d, 'id')) ?? []);
  }

  const name = identifierName(child(declaration, 'id'));
  if (name === null) {
    return [];
  }

  return TYPE_DECLARATIONS.has(declaration.type) ? [`type ${name}`] : [name];
}

export function exportedNames(module: LibModule): string[] {
  const parsed = parse(module.file, readSource(module.file) ?? '');
  const exports = parsed?.program.body.filter((s) => s.type === 'ExportNamedDeclaration') ?? [];

  return exports.flatMap(exportedOf);
}

export function moduleSignatures(module: LibModule): string {
  const source = readSource(module.file) ?? '';

  return signaturesOnly(module.file, source) ?? source;
}

function isCode(path: string): boolean {
  return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.startsWith('fixtures/');
}

function importedLib(sources: readonly string[]): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const source of sources) {
    for (const entry of parse('x.ts', source)?.imports ?? []) {
      if (!entry.specifier.startsWith(LIB_ALIAS)) {
        continue;
      }

      const names = entry.entries.map((e) => (e.isType ? `type ${e.imported}` : e.imported));
      used.set(entry.specifier, [...(used.get(entry.specifier) ?? []), ...names]);
    }
  }

  return used;
}

function folderSources(node: FolderNode): string[] {
  return node.files.filter(isCode).map((path) => readSource(join(node.dir, path)) ?? '');
}

export function libUses(root: string, node: FolderNode): LibUse[] {
  return [...importedLib(folderSources(node)).entries()].flatMap(([specifier, names]) => {
    const module = libModule(root, specifier.slice(LIB_ALIAS.length));

    return module === null
      ? []
      : [{ ...module, names: [...new Set(names)], signatures: moduleSignatures(module) }];
  });
}

export function importersOf(repo: Repo, module: LibModule): string[] {
  return [...repo.folders.values()]
    .filter((node) => node.kind === 'piece' && importedLib(folderSources(node)).has(module.alias))
    .map((node) => node.id)
    .toSorted();
}

export function libTest(module: LibModule): string | null {
  const file = module.file.replace(/\.ts$/, '.test.ts');

  return existsSync(file) ? file : null;
}
