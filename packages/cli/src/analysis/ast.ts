import { parseSync } from 'oxc-parser';

export interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

export interface ImportEntry {
  readonly imported: string;
  readonly local: string;
  readonly isType: boolean;
}

export interface StaticImport {
  readonly specifier: string;
  readonly entries: readonly ImportEntry[];
}

export interface Position {
  readonly line: number;
  readonly col: number;
}

export interface Parsed {
  readonly program: Node & { readonly body: readonly Node[] };
  readonly imports: readonly StaticImport[];
}

interface RawImport {
  readonly moduleRequest: { readonly value: string };
  readonly entries: readonly {
    readonly importName: { readonly name?: string; readonly kind: string };
    readonly localName: { readonly value: string };
    readonly isType: boolean;
  }[];
}

export function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string';
}

export function parse(file: string, source: string): Parsed | null {
  const result = parseSync(file, source);
  if (result.errors.length > 0) {
    return null;
  }

  const imports = (result.module.staticImports as unknown as RawImport[]).map((raw) => ({
    specifier: raw.moduleRequest.value,
    entries: raw.entries.map((e) => ({
      imported: e.importName.kind === 'Default' ? 'default' : (e.importName.name ?? e.importName.kind),
      local: e.localName.value,
      isType: e.isType,
    })),
  }));

  return { program: result.program as unknown as Parsed['program'], imports };
}

export function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visit);
    }

    return;
  }

  if (!isNode(node)) {
    return;
  }

  visit(node);

  for (const value of Object.values(node)) {
    if (typeof value === 'object' && value !== null) {
      walk(value, visit);
    }
  }
}

export function positionOf(source: string, offset: number): Position {
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  const col = offset - before.lastIndexOf('\n');

  return { line, col };
}

export function child(node: Node, key: string): Node | undefined {
  const value = node[key];

  return isNode(value) ? value : undefined;
}

export function identifierName(node: Node | undefined): string | null {
  return node?.type === 'Identifier' ? (node['name'] as string) : null;
}

export function callArguments(call: Node): readonly Node[] {
  return (call['arguments'] as Node[] | undefined) ?? [];
}

function isFunction(node: Node | undefined): boolean {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression';
}

function exportedDeclaration(statement: Node): Node | undefined {
  if (statement.type !== 'ExportNamedDeclaration') {
    return undefined;
  }

  return child(statement, 'declaration');
}

function declaredNames(declaration: Node | undefined): string[] {
  if (declaration === undefined) {
    return [];
  }

  if (declaration.type === 'VariableDeclaration') {
    return (declaration['declarations'] as Node[]).flatMap((d) => identifierName(child(d, 'id')) ?? []);
  }

  const name = identifierName(child(declaration, 'id'));

  return name === null ? [] : [name];
}

function topLevelNames(statement: Node): string[] {
  return declaredNames(exportedDeclaration(statement) ?? statement);
}

function referencedIdentifiers(node: Node): Set<string> {
  const names = new Set<string>();
  walk(node, (n) => {
    if (n.type === 'Identifier') {
      names.add(n['name'] as string);
    }
  });

  return names;
}

export function reachableStatements(parsed: Parsed, source: string, roots: readonly string[]): string[] {
  const statements = parsed.program.body.filter((s) => s.type !== 'ImportDeclaration');
  const byName = new Map(statements.flatMap((s) => topLevelNames(s).map((name) => [name, s] as const)));
  const picked = new Set<Node>();
  const pending = [...roots];

  while (pending.length > 0) {
    const statement = byName.get(pending.pop() as string);
    if (statement === undefined || picked.has(statement)) {
      continue;
    }

    picked.add(statement);
    pending.push(...referencedIdentifiers(statement));
  }

  return statements.filter((s) => picked.has(s)).map((s) => source.slice(s.start, s.end));
}

function elide(source: string, body: Node): string {
  const lines = source.slice(body.start, body.end).split('\n').length;

  return `{ /* …body elided (${lines} lines)… */ }`;
}

function bodyOf(declaration: Node): Node | undefined {
  if (declaration.type === 'FunctionDeclaration') {
    return child(declaration, 'body');
  }

  if (declaration.type !== 'VariableDeclaration') {
    return undefined;
  }

  const [first] = declaration['declarations'] as Node[];
  const init = first === undefined ? undefined : child(first, 'init');

  if (!isFunction(init)) {
    return undefined;
  }

  const body = child(init as Node, 'body');

  return body?.type === 'BlockStatement' ? body : undefined;
}

function signature(source: string, statement: Node): string {
  const declaration = exportedDeclaration(statement) ?? child(statement, 'declaration');
  const body = declaration === undefined ? undefined : bodyOf(declaration);
  const text = source.slice(statement.start, statement.end);

  if (body === undefined) {
    return text;
  }

  return source.slice(statement.start, body.start) + elide(source, body);
}

export function signaturesOnly(file: string, source: string): string | null {
  const parsed = parse(file, source);
  if (parsed === null) {
    return null;
  }

  const kept = parsed.program.body.filter(
    (s) =>
      s.type === 'ImportDeclaration' ||
      s.type === 'ExportNamedDeclaration' ||
      s.type === 'ExportDefaultDeclaration' ||
      s.type === 'ExportAllDeclaration',
  );

  return kept.map((s) => signature(source, s)).join('\n');
}
