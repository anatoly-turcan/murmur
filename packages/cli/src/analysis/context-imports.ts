import { relative } from 'node:path';

import type { Analysis } from './analyze.ts';
import { rejectableLabel } from './catalog.ts';
import type { ServesView } from './context-serves.ts';
import type { LibUse } from './lib.ts';
import type { StaticContract } from './static-app.ts';
import type { ContractInfo, FolderNode } from './types.ts';

export type Imports = Readonly<Record<string, string>>;

const APP_ALIASES: Imports = {
  '#contracts/*': './contracts/*.ts',
  '#capabilities/*': './capabilities/*/capability.ts',
  '#lib/*': './lib/*.ts',
};

interface ImportedName {
  readonly file: string;
  readonly name: string;
  readonly visibility: 'public' | 'internal';
}

export interface SkeletonInput {
  readonly node: FolderNode;
  readonly handles: readonly string[];
  readonly needs: readonly string[];
  readonly contracts: readonly ContractInfo[];
  readonly serves: ServesView | null;
  readonly typesHandles: boolean;
  readonly lib: readonly LibUse[];
}

function aliasOf(imports: Imports, path: string): string | null {
  for (const [pattern, target] of Object.entries(imports)) {
    const star = target.indexOf('*');
    const prefix = target.slice(0, star);
    const suffix = target.slice(star + 1);

    if (star !== -1 && pattern.includes('*') && path.startsWith(prefix) && path.endsWith(suffix)) {
      return pattern.replace('*', path.slice(prefix.length, path.length - suffix.length));
    }
  }

  return null;
}

function posixRelative(from: string, file: string): string {
  return relative(from, file).split('\\').join('/');
}

export function appAlias(root: string, file: string, aliases: Imports): string | null {
  return aliasOf(aliases, `./${posixRelative(root, file)}`);
}

function relativeSpecifier(from: string, file: string): string {
  const path = posixRelative(from, file);

  return path.startsWith('.') ? path : `./${path}`;
}

interface ImportStatement {
  readonly specifier: string;
  readonly defaultName: string | null;
  readonly names: readonly string[];
  readonly typeOnly?: boolean;
}

const HANDLE_TYPES: Readonly<Record<string, string>> = { sqlite: 'Sqlite' };

function appSpecifier(analysis: Analysis, input: SkeletonInput, file: string): string {
  return appAlias(analysis.repo.root, file, APP_ALIASES) ?? relativeSpecifier(input.node.dir, file);
}

function named(names: readonly string[], specifier: string): ImportStatement {
  return { specifier, defaultName: null, names };
}

function handledKinds(analysis: Analysis, handles: readonly string[]): Set<string | undefined> {
  return new Set(analysis.description.contracts.filter((c) => handles.includes(c.name)).map((c) => c.kind));
}

function refuses(analysis: Analysis, input: SkeletonInput): boolean {
  const handled = analysis.description.contracts.filter((c) => input.handles.includes(c.name));

  return handled.some((c) => c.kind === 'guard' || rejectableLabel(c) !== null);
}

function murmurImport(analysis: Analysis, input: SkeletonInput): ImportStatement {
  const kinds = handledKinds(analysis, input.handles);
  const keyed = kinds.has('command') || kinds.has('event');

  return named(
    [
      'Piece',
      ...(input.handles.length > 0 ? ['Handle'] : []),
      ...(keyed ? ['type Delivery'] : []),
      ...(input.serves === null ? [] : ['Serve']),
      ...(refuses(analysis, input) ? ['reject', 'type Rejection'] : []),
    ],
    'murmur',
  );
}

function capabilityOf(need: string): string {
  return need.split('=').at(-1) ?? need;
}

function capabilityImports(analysis: Analysis, input: SkeletonInput): ImportStatement[] {
  const known = analysis.description.capabilities;
  const names = input.needs.map(capabilityOf);
  const own = known.filter((c) => c.origin === 'local' && c.file !== null && names.includes(c.name));
  const builtin = names.filter((name) => !own.some((c) => c.name === name));

  return [
    ...(builtin.length === 0 ? [] : [named(builtin, '@murmur/node/capabilities')]),
    ...handleTypeImport(input, builtin),
    ...own.map((c) => ({
      specifier: appSpecifier(analysis, input, c.file as string),
      defaultName: c.name,
      names: [],
    })),
  ];
}

function handleTypeImport(input: SkeletonInput, builtin: readonly string[]): ImportStatement[] {
  const handles = input.typesHandles ? builtin.flatMap((name) => HANDLE_TYPES[name] ?? []) : [];
  const types = [
    ...handles,
    ...(input.serves !== null && needsWebRequest(input.serves) ? ['HttpResult'] : []),
  ];

  return types.length === 0 ? [] : [{ ...named(types, '@murmur/node/capabilities'), typeOnly: true }];
}

function needsWebRequest(serves: ServesView): boolean {
  return serves.fromLane || serves.rows.some((row) => row.via.startsWith('method'));
}

function tokenImports(analysis: Analysis, input: SkeletonInput): ImportStatement[] {
  const { serves } = input;
  if (serves === null) {
    return [];
  }

  const names = needsWebRequest(serves) ? ['type WebRequest'] : [];
  const used = new Set(serves.tokens.map((token) => token.name));
  const tokens = analysis.statics.app.tokens.filter((token) => used.has(token.name));

  return tokens.map((token) => ({
    specifier: appSpecifier(analysis, input, token.file),
    defaultName: token.name,
    names,
  }));
}

function contractNames(input: SkeletonInput): ImportedName[] {
  return input.contracts.map((c) => ({ file: c.file, name: c.exportName, visibility: c.visibility }));
}

function staticContract(analysis: Analysis, wireName: string): StaticContract | undefined {
  return analysis.statics.app.contracts.find((c) => c.wireName === wireName);
}

function replyModelNames(analysis: Analysis, input: SkeletonInput): ImportedName[] {
  return input.handles.flatMap((wireName) => {
    const contract = staticContract(analysis, wireName);
    const model = contract === undefined ? null : analysis.statics.app.modelIn(contract);

    if (model === null || model.kind !== 'model') {
      return [];
    }

    return [{ file: model.file, name: `type ${model.className}`, visibility: model.visibility }];
  });
}

function routeGuardNames(input: SkeletonInput): string[] {
  const rows = input.serves?.rows ?? [];

  return rows.flatMap((row) => [...row.skipped, ...row.added].map((guard) => guard.wireName));
}

function guardNames(analysis: Analysis, input: SkeletonInput): ImportedName[] {
  return routeGuardNames(input).flatMap((wireName) => {
    const guard = staticContract(analysis, wireName);

    return guard === undefined
      ? []
      : [{ file: guard.file, name: guard.className, visibility: guard.visibility }];
  });
}

function contractSpecifier(
  analysis: Analysis,
  input: SkeletonInput,
  file: string,
  entries: ImportedName[],
): string {
  if (entries[0]?.visibility === 'public') {
    return appSpecifier(analysis, input, file);
  }

  return relativeSpecifier(input.node.dir, file);
}

function contractImports(analysis: Analysis, input: SkeletonInput): ImportStatement[] {
  const names = [
    ...contractNames(input),
    ...replyModelNames(analysis, input),
    ...guardNames(analysis, input),
  ];
  const byFile = Map.groupBy(names, (name) => name.file);

  return [...byFile.entries()].map(([file, entries]) =>
    named(
      entries.map((entry) => entry.name),
      contractSpecifier(analysis, input, file, entries),
    ),
  );
}

function missingAliases(aliases: Imports, skeleton: readonly string[]): string[] {
  return Object.entries(APP_ALIASES)
    .filter(([pattern, target]) => aliases[pattern] !== target)
    .filter(([pattern]) => skeleton.some((line) => line.includes(`'${pattern.replace('*', '')}`)))
    .map(([pattern, target]) => `"${pattern}": "${target}"`);
}

export function aliasNote(aliases: Imports, skeleton: readonly string[]): string | null {
  const missing = missingAliases(aliases, skeleton);
  if (missing.length === 0) {
    return null;
  }

  return `> package.json lacks these aliases; add them: \`"imports": { ${missing.join(', ')} }\``;
}

function byName(a: string, b: string): number {
  return a.replace(/^type /, '').localeCompare(b.replace(/^type /, ''), 'en', { sensitivity: 'base' });
}

function bySpecifier(a: ImportStatement, b: ImportStatement): number {
  if (a.specifier === b.specifier) {
    return 0;
  }

  return a.specifier < b.specifier ? -1 : 1;
}

function formatterGroup(statement: ImportStatement): number {
  if (statement.specifier.startsWith('#')) {
    return 1;
  }

  return statement.specifier.startsWith('.') ? 2 : 0;
}

function inFormatterOrder(statements: readonly ImportStatement[]): ImportStatement[][] {
  const groups = [0, 1, 2].map((group) =>
    statements.filter((statement) => formatterGroup(statement) === group).toSorted(bySpecifier),
  );

  return groups.filter((group) => group.length > 0);
}

function renderImport(statement: ImportStatement): string {
  const names = [...new Set(statement.names)].toSorted(byName);
  const braces = names.length === 0 ? '' : `{ ${names.join(', ')} }`;
  const bindings = [statement.defaultName ?? '', braces].filter((part) => part !== '').join(', ');

  const keyword = statement.typeOnly === true ? 'import type' : 'import';

  return `${keyword} ${bindings} from '${statement.specifier}';`;
}

export function importSkeleton(analysis: Analysis, input: SkeletonInput): string[] {
  const groups = inFormatterOrder([
    murmurImport(analysis, input),
    ...capabilityImports(analysis, input),
    ...tokenImports(analysis, input),
    ...contractImports(analysis, input),
    ...input.lib.map((use) => named(use.names, use.alias)),
  ]);

  return groups.flatMap((group, i) => [...(i === 0 ? [] : ['']), ...group.map(renderImport)]);
}
