import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

import type { Analysis } from './analyze.ts';
import { readPackageImports } from './app-files.ts';
import { parse, reachableStatements } from './ast.ts';
import { sendersOf } from './catalog.ts';
import { aliasNote, appAlias, type Imports, importSkeleton } from './context-imports.ts';
import { servesView, type ServesView } from './context-serves.ts';
import { importedContracts } from './contract-imports.ts';
import { docRef } from './docs.ts';
import { stripFrontmatter } from './frontmatter.ts';
import { contractLanes, unique } from './lanes.ts';
import { libUses, type LibUse } from './lib.ts';
import { firstParagraph } from './markdown.ts';
import { processLine } from './processes.ts';
import { regenerationOf, type Regeneration } from './regeneration.ts';
import { readSource } from './source-checks.ts';
import { estimateTokens } from './tokens.ts';
import type { CapabilityInfo, ConfigKeyInfo, ContractInfo, FolderNode, PieceInfo } from './types.ts';

export interface SourceFile {
  readonly path: string;
  readonly source: string;
}

export interface FolderFile {
  readonly path: string;
  readonly lines: number;
  readonly tokens: number;
}

export interface ContractGroup {
  readonly label: string;
  readonly contracts: readonly ContractInfo[];
  readonly code: readonly string[];
}

export interface CapabilitySheet {
  readonly name: string;
  readonly label: string;
  readonly docs: string | null;
  readonly interfaceBlock: string | null;
}

export interface Relative {
  readonly kind: 'sibling' | 'child';
  readonly id: string;
  readonly summary: string | null;
}

export interface ContextSubject {
  readonly id: string;
  readonly node: FolderNode;
  readonly info: PieceInfo | undefined;
  readonly regeneration: Regeneration | null;
  readonly pieceSource: string | null;
  readonly privateFiles: readonly SourceFile[];
  readonly files: readonly FolderFile[];
  readonly chain: readonly SourceFile[];
  readonly ownContext: string | null;
  readonly relatives: readonly Relative[];
  readonly contracts: readonly ContractGroup[];
  readonly tests: readonly SourceFile[];
  readonly fixtures: readonly SourceFile[];
  readonly capabilities: readonly CapabilitySheet[];
  readonly config: readonly ConfigKeyInfo[];
  readonly neighbors: readonly { readonly id: string; readonly paragraph: string }[];
  readonly sizingDoc: string;
  readonly serves: ServesView | null;
  readonly schema: SourceFile | null;
  readonly imports: readonly string[];
  readonly importNote: string | null;
  readonly lib: readonly LibUse[];
  readonly processLine: string | null;
}

const DEFAULTS = new Set(['log', 'clock', 'ids']);

function ancestorsOf(id: string): string[] {
  const parts = id.split('/');

  return ['', ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))];
}

function contextText(node: FolderNode | undefined): string | null {
  if (node?.contextFile === null || node === undefined) {
    return null;
  }

  const text = readSource(node.contextFile);

  return text === null ? null : stripFrontmatter(text);
}

function chainOf(analysis: Analysis, id: string): SourceFile[] {
  return ancestorsOf(id).flatMap((ancestor) => {
    const node = analysis.repo.folders.get(ancestor);
    const text = contextText(node);

    if (node === undefined || text === null) {
      return [];
    }

    return [{ path: relative(analysis.repo.root, node.contextFile as string), source: text }];
  });
}

function relativesOf(analysis: Analysis, node: FolderNode): Relative[] {
  const { folders } = analysis.repo;
  const siblings =
    node.parent === null ? [] : (folders.get(node.parent)?.children ?? []).filter((c) => c !== node.id);
  const describe = (kind: Relative['kind']) => (id: string) => ({
    kind,
    id,
    summary: folders.get(id)?.summary ?? null,
  });

  return [...siblings.map(describe('sibling')), ...node.children.map(describe('child'))];
}

function isPrivate(path: string): boolean {
  return (
    path.endsWith('.ts') &&
    path !== 'piece.ts' &&
    path !== 'contracts.ts' &&
    !path.endsWith('.test.ts') &&
    !path.startsWith('fixtures/')
  );
}

function importOrder(node: FolderNode, pieceSource: string | null): string[] {
  const parsed = pieceSource === null ? null : parse('piece.ts', pieceSource);
  if (parsed === null) {
    return [];
  }

  return parsed.imports
    .filter((i) => i.specifier.startsWith('.'))
    .map((i) => relative(node.dir, resolve(node.dir, i.specifier)).split('\\').join('/'));
}

function privateFilesOf(node: FolderNode, pieceSource: string | null): SourceFile[] {
  const order = importOrder(node, pieceSource);
  const rank = (path: string) => (order.includes(path) ? order.indexOf(path) : order.length);
  const paths = node.files.filter(isPrivate).toSorted((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  return paths.map((path) => ({ path, source: readSource(join(node.dir, path)) ?? '' }));
}

function isWithheld(path: string): boolean {
  return path === 'piece.ts' || isPrivate(path);
}

function lineCount(source: string): number {
  return source === '' ? 0 : source.replace(/\n$/, '').split('\n').length;
}

function folderFiles(root: string, node: FolderNode, regeneration: Regeneration | null): FolderFile[] {
  const withheld = regeneration?.reason === 'withheld';

  return node.files
    .filter((path) => !(withheld && isWithheld(path)))
    .toSorted((a, b) => a.localeCompare(b))
    .map((path) => {
      const full = join(node.dir, path);
      const source = readSource(full) ?? '';

      return {
        path: relative(root, full).split('\\').join('/'),
        lines: lineCount(source),
        tokens: estimateTokens(source),
      };
    });
}

function filesOf(node: FolderNode, keep: (path: string) => boolean): SourceFile[] {
  return node.files.filter(keep).map((path) => ({ path, source: readSource(join(node.dir, path)) ?? '' }));
}

function importedContractNames(analysis: Analysis, node: FolderNode, sources: readonly string[]): string[] {
  const { contracts } = analysis.description;

  return sources.flatMap((source) =>
    [...importedContracts(contracts, analysis.repo.root, node.dir, source).values()].map((c) => c.name),
  );
}

function mentionedContractNames(analysis: Analysis, text: string | null): string[] {
  if (text === null) {
    return [];
  }

  return analysis.description.contracts.filter((c) => text.includes(c.name)).map((c) => c.name);
}

function labelOf(analysis: Analysis, contract: ContractInfo, aliases: Imports): string {
  const { root } = analysis.repo;
  const alias = contract.visibility === 'public' ? appAlias(root, contract.file, aliases) : null;

  return alias ?? relative(root, contract.file);
}

function contractGroups(analysis: Analysis, names: readonly string[], aliases: Imports): ContractGroup[] {
  const used = analysis.description.contracts.filter((c) => names.includes(c.name));
  const byFile = Map.groupBy(used, (c) => c.file);

  return [...byFile.entries()].map(([file, contracts]) => {
    const source = readSource(file) ?? '';
    const parsed = parse(file, source);
    const roots = contracts.map((c) => c.exportName);

    return {
      label: labelOf(analysis, contracts[0] as ContractInfo, aliases),
      contracts,
      code: parsed === null ? [] : reachableStatements(parsed, source, roots),
    };
  });
}

function pascal(name: string): string {
  return name.replace(/(^|[-_])([a-z])/g, (_, _sep: string, c: string) => c.toUpperCase());
}

function interfaceIn(source: string, name: string): string | null {
  const start = source.search(new RegExp(`export (interface|type) ${name}\\b`));
  if (start === -1) {
    return null;
  }

  const rest = source.slice(start);
  if (rest.startsWith('export type')) {
    return rest.split('\n')[0] ?? null;
  }

  const end = rest.search(/\n\}/);

  return end === -1 ? null : rest.slice(0, end + 2);
}

function builtinTypes(analysis: Analysis): string | null {
  try {
    const entry = createRequire(join(analysis.repo.root, 'package.json')).resolve(
      '@murmur/node/capabilities',
    );

    return join(dirname(entry), 'types.ts');
  } catch {
    return null;
  }
}

function interfaceBlock(
  analysis: Analysis,
  capability: CapabilityInfo | undefined,
  name: string,
): string | null {
  const own = capability?.file ?? null;
  const builtin = builtinTypes(analysis);

  if (own !== null && existsSync(own)) {
    const found = interfaceIn(readFileSync(own, 'utf8'), pascal(name));
    if (found !== null) {
      return found;
    }
  }

  const found =
    builtin !== null && existsSync(builtin) ? interfaceIn(readFileSync(builtin, 'utf8'), pascal(name)) : null;

  if (found === null) {
    return null;
  }

  return `import type { ${pascal(name)} } from '@murmur/node/capabilities';\n\n${found}`;
}

function sheetOf(analysis: Analysis, need: string): CapabilitySheet {
  const [field, capabilityName] = need.includes('=') ? need.split('=') : [null, need];
  const name = capabilityName ?? need;
  const capability = analysis.description.capabilities.find((c) => c.name === name);

  return {
    name,
    label: field === null ? name : `${field} (${name})`,
    docs: capability?.docs ?? null,
    interfaceBlock: interfaceBlock(analysis, capability, name),
  };
}

function capabilitySheets(analysis: Analysis, needs: readonly string[]): CapabilitySheet[] {
  return needs.filter((name) => !DEFAULTS.has(name)).map((need) => sheetOf(analysis, need));
}

function schemaOf(node: FolderNode): SourceFile | null {
  if (!node.files.includes('schema.sql')) {
    return null;
  }

  return { path: 'schema.sql', source: readSource(join(node.dir, 'schema.sql')) ?? '' };
}

function neighborsOf(analysis: Analysis, id: string, names: readonly string[]): ContextSubject['neighbors'] {
  const involved = analysis.catalog.contracts.flatMap((c) =>
    names.includes(c.name) ? [...sendersOf(c), ...c.handlers] : [],
  );
  const ids = [...new Set(involved)].filter((other) => other !== id && !other.startsWith('(external'));

  return ids.map((other) => ({
    id: other,
    paragraph: firstParagraph(contextText(analysis.repo.folders.get(other)) ?? ''),
  }));
}

function codeContractNames(
  analysis: Analysis,
  node: FolderNode,
  info: PieceInfo | undefined,
  sources: readonly string[],
): string[] {
  return [
    ...(info?.handlers.map((h) => h.contract) ?? []),
    ...(info?.emits ?? []),
    ...(info?.requests ?? []),
    ...importedContractNames(analysis, node, sources),
  ];
}

function regenerationContractNames(
  analysis: Analysis,
  regeneration: Regeneration,
  own: string | null,
): string[] {
  const { lanes } = regeneration;
  const known = Object.values(lanes).some((lane) => lane.source !== 'none');

  return known ? contractLanes(lanes) : mentionedContractNames(analysis, own);
}

export interface SubjectOptions {
  readonly withholdCode: boolean;
}

function ownContractNames(
  analysis: Analysis,
  node: FolderNode,
  info: PieceInfo | undefined,
  sources: readonly string[],
  ownContext: string | null,
): string[] {
  const mentioned = node.pieceFile === null ? mentionedContractNames(analysis, ownContext) : [];

  return [...codeContractNames(analysis, node, info, sources), ...mentioned];
}

export function contextSubject(
  analysis: Analysis,
  node: FolderNode,
  options: SubjectOptions,
): ContextSubject {
  const info = analysis.description.pieces.find((p) => p.id === node.id);
  const ownContext = contextText(node);
  const regeneration = regenerationOf({
    analysis,
    node,
    info,
    ownContext,
    withholdCode: options.withholdCode,
  });
  const pieceSource = node.pieceFile === null || regeneration !== null ? null : readSource(node.pieceFile);
  const privateFiles = regeneration === null ? privateFilesOf(node, pieceSource) : [];
  const names = unique(
    regeneration === null
      ? ownContractNames(
          analysis,
          node,
          info,
          [pieceSource ?? '', ...privateFiles.map((f) => f.source)],
          ownContext,
        )
      : regenerationContractNames(analysis, regeneration, ownContext),
  );
  const needs =
    regeneration === null ? (info?.needFields ?? info?.needs ?? []) : regeneration.lanes.needs.values;
  const handles =
    regeneration === null ? (info?.handlers.map((h) => h.contract) ?? []) : regeneration.lanes.listens.values;
  const aliases = readPackageImports(analysis.repo.root);
  const contracts = contractGroups(analysis, names, aliases);
  const serves = servesView(analysis.statics.app, info, regeneration?.lanes.serves.values ?? []);
  const used = contracts.flatMap((group) => group.contracts);
  const typesHandles = regeneration !== null || node.files.some(isPrivate);
  const lib = libUses(analysis.repo.root, node);
  const imports = importSkeleton(analysis, {
    node,
    handles,
    needs,
    contracts: used,
    serves,
    typesHandles,
    lib,
  });

  return {
    id: node.id,
    node,
    info,
    regeneration,
    pieceSource,
    privateFiles,
    files: folderFiles(analysis.repo.root, node, regeneration),
    chain: chainOf(analysis, node.id),
    ownContext,
    relatives: relativesOf(analysis, node),
    contracts,
    tests: filesOf(node, (path) => path.endsWith('.test.ts')),
    fixtures: filesOf(node, (path) => path.startsWith('fixtures/')),
    capabilities: capabilitySheets(analysis, needs),
    config: regeneration?.config ?? info?.config ?? [],
    neighbors: neighborsOf(analysis, node.id, names),
    sizingDoc: docRef('piece-authoring', analysis.repo.root),
    serves,
    schema: schemaOf(node),
    imports,
    importNote: aliasNote(aliases, imports),
    lib,
    processLine: node.kind === 'piece' || regeneration !== null ? processLine(analysis, node.id) : null,
  };
}
