import {
  callArguments,
  child,
  identifierName,
  isNode,
  parse,
  positionOf,
  walk,
  type Node,
  type Position,
  type StaticImport,
} from './ast.ts';
import type { ContractKind } from './types.ts';

export type ClassKind = 'model' | ContractKind;

export interface MetaKeyFact {
  readonly key: string;
  readonly fallback: string | null;
}

export interface GuardFact {
  readonly after: readonly string[];
  readonly optional: readonly string[];
  readonly meta: readonly MetaKeyFact[];
  readonly metaOpen: boolean;
}

export interface ContractFact extends Position {
  readonly className: string;
  readonly kind: ClassKind;
  readonly explicitName: string | null;
  readonly fields: readonly string[] | null;
  readonly nested: Readonly<Record<string, string | null>>;
  readonly requiredFields: readonly string[] | null;
  readonly output: string | null;
  readonly outputType: string | null;
  readonly exported: boolean;
  readonly guard: GuardFact | null;
}

export interface NeedFact {
  readonly field: string;
  readonly token: string | null;
}

export interface ConfigFact {
  readonly key: string;
  readonly type: string;
  readonly hasDefault: boolean;
}

export interface HandleFact extends Position {
  readonly contract: string | null;
  readonly method: string;
  readonly every: string | null;
  readonly everyLiteral: boolean;
  readonly hasRetry: boolean;
  readonly retry: unknown;
  readonly retryLiteral: boolean;
}

export interface EnqueueFact extends Position {
  readonly field: string;
  readonly contract: string | null;
}

export interface IdempotentFact {
  readonly scope: readonly string[] | null;
  readonly ttlMs: number | null;
}

export interface ServeFact extends Position {
  readonly method: string | null;
  readonly token: string | null;
  readonly maker: string | null;
  readonly verb: string | null;
  readonly path: string | null;
  readonly status: number | null;
  readonly skip: readonly string[];
  readonly guards: readonly string[];
  readonly meta: readonly string[];
  readonly metaText: string | null;
  readonly idempotent: IdempotentFact | null;
  readonly contract: string | null;
  readonly inputs: readonly string[];
  readonly paramKeys: readonly string[];
  readonly requests: readonly CallFact[];
  readonly text: string;
}

export interface CallFact extends Position {
  readonly contract: string | null;
  readonly text: string;
}

export interface PieceFact extends Position {
  readonly className: string;
  readonly exported: boolean;
  readonly needs: readonly NeedFact[];
  readonly config: readonly ConfigFact[];
  readonly emits: readonly string[];
  readonly policy: Readonly<Record<string, unknown>>;
  readonly handles: readonly HandleFact[];
  readonly serves: readonly ServeFact[];
  readonly emitCalls: readonly CallFact[];
  readonly requestCalls: readonly CallFact[];
  readonly enqueueCalls: readonly EnqueueFact[];
  readonly methods: readonly MethodFact[];
}

export interface MethodFact extends Position {
  readonly name: string;
}

export interface ErrorStatus {
  readonly name: string;
  readonly status: number;
  readonly code: string;
}

export interface IssueRename {
  readonly from: string;
  readonly to: string;
}

export interface TokenFact {
  readonly bindings: readonly string[];
  readonly factory: 'http' | 'capability';
  readonly name: string | null;
  readonly guards: readonly string[];
  readonly errors: readonly ErrorStatus[];
  readonly inputErrors: readonly ErrorStatus[];
  readonly issueCodes: readonly IssueRename[];
  readonly idempotencyErrors: readonly ErrorStatus[];
  readonly customEnvelope: boolean;
  readonly responseHeaders: boolean;
  readonly log: boolean;
}

export interface ExportFact extends Position {
  readonly name: string;
}

export interface ReexportFact {
  readonly specifier: string;
  readonly imported: string;
  readonly exported: string;
}

export interface FileFacts {
  readonly file: string;
  readonly parsed: boolean;
  readonly imports: readonly StaticImport[];
  readonly contracts: readonly ContractFact[];
  readonly pieces: readonly PieceFact[];
  readonly tokens: readonly TokenFact[];
  readonly exports: readonly ExportFact[];
  readonly reexports: readonly ReexportFact[];
}

interface Reader {
  readonly source: string;
  at(node: Node): Position;
  text(node: Node): string;
}

const FACTORY_KINDS: Readonly<Record<string, ClassKind>> = {
  Model: 'model',
  Query: 'query',
  Command: 'command',
  Event: 'event',
  Guard: 'guard',
};

const OPTIONS_AT: Readonly<Record<ClassKind, number>> = {
  model: -1,
  query: 2,
  command: 2,
  event: 1,
  guard: 1,
};

const ROUTE_MAKERS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete']);

const DEFAULT_MARKERS = /\.(default|optional|nullish|prefault)\(/;

const ZOD_TYPES: Readonly<Record<string, string>> = {
  int: 'number',
  record: 'object',
  url: 'string',
  email: 'string',
  uuid: 'string',
  iso: 'string',
  literal: 'enum',
};

function nodes(value: unknown): Node[] {
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function readerOf(source: string): Reader {
  return {
    source,
    at: (node) => positionOf(source, node.start),
    text: (node) => source.slice(node.start, node.end),
  };
}

function keyName(member: Node): string | null {
  const key = child(member, 'key');
  if (key?.type === 'Identifier') {
    return identifierName(key);
  }

  if (key?.type === 'PrivateIdentifier') {
    return `#${String(key['name'])}`;
  }

  if (key?.type === 'Literal' && typeof key['value'] === 'string') {
    return key['value'];
  }

  return null;
}

function properties(object: Node | undefined): Node[] {
  if (object?.type !== 'ObjectExpression') {
    return [];
  }

  return nodes(object['properties']).filter((p) => p.type === 'Property');
}

function property(object: Node | undefined, name: string): Node | undefined {
  const found = properties(object).find((p) => keyName(p) === name);

  return found === undefined ? undefined : child(found, 'value');
}

function stringValue(node: Node | undefined): string | null {
  if (node?.type === 'Literal' && typeof node['value'] === 'string') {
    return node['value'];
  }

  const quasis = nodes(node?.['quasis']);
  if (node?.type === 'TemplateLiteral' && quasis.length === 1) {
    return String((quasis[0]?.['value'] as { cooked?: string } | undefined)?.cooked ?? '');
  }

  return null;
}

function numberValue(node: Node | undefined): number | null {
  return node?.type === 'Literal' && typeof node['value'] === 'number' ? node['value'] : null;
}

function identifiers(node: Node | undefined): string[] {
  if (node?.type !== 'ArrayExpression') {
    return [];
  }

  return nodes(node['elements']).flatMap((element) => identifierName(element) ?? []);
}

function isLiteral(node: Node | undefined): boolean {
  if (node?.type === 'Literal') {
    return true;
  }

  if (node?.type === 'ArrayExpression') {
    return nodes(node['elements']).every(isLiteral);
  }

  if (node?.type === 'ObjectExpression') {
    const members = nodes(node['properties']);

    return members.every((p) => p.type === 'Property' && keyName(p) !== null && isLiteral(child(p, 'value')));
  }

  return false;
}

export function literalValue(node: Node | undefined): unknown {
  if (node?.type === 'Literal') {
    return node['value'];
  }

  if (node?.type === 'ArrayExpression') {
    return nodes(node['elements']).map(literalValue);
  }

  if (node?.type === 'ObjectExpression') {
    return Object.fromEntries(properties(node).map((p) => [keyName(p), literalValue(child(p, 'value'))]));
  }

  return undefined;
}

function calleeName(call: Node | undefined): string | null {
  return call?.type === 'CallExpression' ? identifierName(child(call, 'callee')) : null;
}

function shapeProperties(node: Node | undefined): Node[] | null {
  if (node?.type === 'ObjectExpression') {
    return properties(node);
  }

  const callee = node?.type === 'CallExpression' ? child(node, 'callee') : undefined;
  const method = callee?.type === 'MemberExpression' ? identifierName(child(callee, 'property')) : null;

  if (method === 'object' || method === 'strictObject' || method === 'looseObject') {
    return shapeProperties(callArguments(node as Node)[0]);
  }

  return null;
}

function shapeFields(node: Node | undefined): string[] | null {
  return shapeProperties(node)?.flatMap((p) => keyName(p) ?? []) ?? null;
}

const OPEN_ZOD: ReadonlySet<string> = new Set([
  'object',
  'strictObject',
  'looseObject',
  'record',
  'any',
  'unknown',
  'custom',
  'lazy',
  'union',
  'intersection',
  'discriminatedUnion',
]);

function chainRoot(node: Node | undefined): { base: string | null; member: string | null } {
  if (node?.type === 'CallExpression') {
    return chainRoot(child(node, 'callee'));
  }

  const object = node?.type === 'MemberExpression' ? child(node, 'object') : undefined;
  if (object?.type === 'Identifier') {
    return { base: identifierName(object), member: identifierName(child(node as Node, 'property')) };
  }

  if (object !== undefined) {
    return chainRoot(object);
  }

  return { base: identifierName(node), member: null };
}

function nestedRef(node: Node | undefined): string | null | undefined {
  const { base, member } = chainRoot(node);
  if (base === 'z') {
    return member !== null && OPEN_ZOD.has(member) ? null : undefined;
  }

  return base;
}

function nestedFields(node: Node | undefined): Record<string, string | null> {
  return Object.fromEntries(
    (shapeProperties(node) ?? []).flatMap((p) => {
      const key = keyName(p);
      const ref = nestedRef(child(p, 'value'));

      return key === null || ref === undefined ? [] : [[key, ref]];
    }),
  );
}

const OPTIONAL_METHODS = new Set(['optional', 'default', 'nullish', 'prefault', 'catch']);

function isOptionalField(node: Node | undefined): boolean {
  const callee = node?.type === 'CallExpression' ? child(node, 'callee') : undefined;
  if (callee?.type !== 'MemberExpression') {
    return false;
  }

  const method = identifierName(child(callee, 'property'));

  return (method !== null && OPTIONAL_METHODS.has(method)) || isOptionalField(child(callee, 'object'));
}

function requiredFields(node: Node | undefined): string[] | null {
  const shape = shapeProperties(node);
  if (shape === null) {
    return null;
  }

  return shape.filter((p) => !isOptionalField(child(p, 'value'))).flatMap((p) => keyName(p) ?? []);
}

const OUTPUT_WRAPPERS: Readonly<Record<string, (model: string) => string>> = {
  nullable: (model) => `${model} | null`,
  optional: (model) => `${model} | undefined`,
  array: (model) => `${model}[]`,
};

const NO_OUTPUT = { model: null, type: null } as const;

function outputOf(node: Node | undefined): { model: string | null; type: string | null } {
  const direct = identifierName(node);
  if (direct !== null) {
    return { model: direct, type: direct };
  }

  const callee = node?.type === 'CallExpression' ? child(node, 'callee') : undefined;
  if (callee?.type !== 'MemberExpression') {
    return NO_OUTPUT;
  }

  const model = identifierName(child(callee, 'object'));
  const wrap = OUTPUT_WRAPPERS[identifierName(child(callee, 'property')) ?? ''];

  return { model, type: model === null || wrap === undefined ? null : wrap(model) };
}

const DEFAULT_CALL = /\.(?:default|prefault)\(([\s\S]*)\)\s*$/;

function metaKeyFacts(reader: Reader, meta: Node | undefined): MetaKeyFact[] {
  return properties(meta).flatMap((p) => {
    const key = keyName(p);
    const value = child(p, 'value');

    if (key === null || value === undefined) {
      return [];
    }

    return [{ key, fallback: DEFAULT_CALL.exec(reader.text(value))?.[1]?.trim() ?? null }];
  });
}

function isOpenObject(node: Node | undefined): boolean {
  if (node === undefined) {
    return false;
  }

  return node.type !== 'ObjectExpression' || nodes(node['properties']).some((p) => p.type !== 'Property');
}

function guardFact(reader: Reader, kind: ClassKind, options: Node | undefined): GuardFact | null {
  if (kind !== 'guard') {
    return null;
  }

  const meta = property(options, 'meta');

  return {
    after: identifiers(property(options, 'after')),
    optional: identifiers(property(options, 'optional')),
    meta: metaKeyFacts(reader, meta),
    metaOpen: isOpenObject(meta),
  };
}

function contractFact(reader: Reader, cls: Node, kind: ClassKind, exported: boolean): ContractFact {
  const args = callArguments(child(cls, 'superClass') as Node);
  const options = OPTIONS_AT[kind] === -1 ? undefined : args[OPTIONS_AT[kind]];
  const outputArg = kind === 'guard' ? args[0] : args[1];
  const output = kind === 'event' || kind === 'model' ? NO_OUTPUT : outputOf(outputArg);

  return {
    className: identifierName(child(cls, 'id')) ?? '',
    kind,
    explicitName: stringValue(property(options, 'name')),
    fields: kind === 'guard' ? null : shapeFields(args[0]),
    nested: kind === 'guard' ? {} : nestedFields(args[0]),
    requiredFields: kind === 'guard' ? null : requiredFields(args[0]),
    output: output.model,
    outputType: output.type,
    exported,
    guard: guardFact(reader, kind, options),
    ...reader.at(cls),
  };
}

function zodType(text: string): string {
  const base = /^z\s*\.\s*(\w+)/.exec(text.trim())?.[1];
  if (base === undefined) {
    return 'unknown';
  }

  return ZOD_TYPES[base] ?? base;
}

function configFacts(reader: Reader, declaration: Node | undefined): ConfigFact[] {
  return properties(property(declaration, 'config')).flatMap((p) => {
    const key = keyName(p);
    const value = child(p, 'value');

    if (key === null || value === undefined) {
      return [];
    }

    const text = reader.text(value);

    return [{ key, type: zodType(text), hasDefault: DEFAULT_MARKERS.test(text) }];
  });
}

function needFacts(declaration: Node | undefined): NeedFact[] {
  return properties(property(declaration, 'needs')).flatMap((p) => {
    const field = keyName(p);
    if (field === null) {
      return [];
    }

    return [{ field, token: identifierName(child(p, 'value')) }];
  });
}

function decoratorCalls(node: Node, name: string): Node[] {
  return nodes(node['decorators'])
    .map((decorator) => child(decorator, 'expression'))
    .filter((expression): expression is Node => calleeName(expression) === name);
}

function memberCall(node: Node | undefined): { object: string | null; property: string | null } {
  const callee = node?.type === 'CallExpression' ? child(node, 'callee') : undefined;
  if (callee?.type !== 'MemberExpression') {
    return { object: null, property: null };
  }

  return {
    object: identifierName(child(callee, 'object')),
    property: identifierName(child(callee, 'property')),
  };
}

function readParams(call: Node): Node | undefined {
  return property(callArguments(call)[0], 'params');
}

function paramsContract(params: Node | undefined): string | null {
  if (params?.type !== 'MemberExpression' || identifierName(child(params, 'property')) !== 'input') {
    return null;
  }

  return identifierName(child(params, 'object'));
}

function readCalls(body: Node | undefined): Node[] {
  const found: Node[] = [];

  walk(body, (node) => {
    if (node.type === 'CallExpression' && memberCall(node).property === 'read') {
      found.push(node);
    }
  });

  return found;
}

function inputCalls(body: Node | undefined): string[] {
  const contracts = readCalls(body).flatMap((call) => paramsContract(readParams(call)) ?? []);

  return [...new Set(contracts)];
}

function paramKeys(body: Node | undefined): string[] {
  const keys = readCalls(body).flatMap((call) => shapeFields(readParams(call)) ?? []);

  return [...new Set(keys)];
}

function verbAndPath(
  maker: string | null,
  args: readonly Node[],
): { verb: string | null; path: Node | undefined } {
  if (maker === 'raw') {
    return { verb: stringValue(args[0])?.toUpperCase() ?? null, path: args[1] };
  }

  if (maker === null || !ROUTE_MAKERS.has(maker)) {
    return { verb: null, path: args[0] };
  }

  return { verb: maker.toUpperCase(), path: args[0] };
}

function stringList(node: Node | undefined): string[] | null {
  if (node?.type !== 'ArrayExpression') {
    return null;
  }

  const values = nodes(node['elements']).map(stringValue);

  return values.every((value): value is string => value !== null) ? values : null;
}

function idempotentFact(options: Node | undefined): IdempotentFact | null {
  const idempotent = property(options, 'idempotent');
  if (idempotent === undefined) {
    return null;
  }

  return {
    scope: stringList(property(idempotent, 'scope')),
    ttlMs: numberValue(property(idempotent, 'ttlMs')),
  };
}

function serveFact(reader: Reader, call: Node, method: Node | null): ServeFact {
  const [binding, contract] = callArguments(call);
  const { object, property: maker } = memberCall(binding);
  const args = binding === undefined || binding.type !== 'CallExpression' ? [] : callArguments(binding);
  const { verb, path } = verbAndPath(maker, args);
  const options = maker === 'raw' ? args[2] : args[1];
  const meta = property(options, 'meta');
  const body = method === null ? undefined : child(method, 'value');

  return {
    method: method === null ? null : keyName(method),
    token: object,
    maker,
    verb,
    path: stringValue(path),
    status: numberValue(property(options, 'status')),
    skip: identifiers(property(options, 'skip')),
    guards: identifiers(property(options, 'guards')),
    meta: properties(meta).flatMap((p) => keyName(p) ?? []),
    metaText: meta === undefined ? null : reader.text(meta).replaceAll(/\s+/g, ' '),
    idempotent: idempotentFact(options),
    contract: identifierName(contract),
    inputs: method === null ? [] : inputCalls(body),
    paramKeys: method === null ? [] : paramKeys(body),
    requests: method === null ? [] : thisCalls(reader, body, 'request'),
    text: reader.text(call),
    ...reader.at(call),
  };
}

function handleFacts(reader: Reader, method: Node): HandleFact[] {
  return decoratorCalls(method, 'Handle').map((call) => {
    const [contract, options] = callArguments(call);
    const every = property(options, 'every');
    const retry = property(options, 'retry');

    return {
      contract: identifierName(contract),
      method: keyName(method) ?? '',
      every: every === undefined ? null : (stringValue(every) ?? reader.text(every)),
      everyLiteral: every !== undefined && stringValue(every) !== null,
      hasRetry: retry !== undefined,
      retry: literalValue(retry),
      retryLiteral: isLiteral(retry),
      ...reader.at(call),
    };
  });
}

function thisCalls(reader: Reader, body: Node | undefined, name: string): CallFact[] {
  const found: CallFact[] = [];

  walk(body, (node) => {
    const callee = node.type === 'CallExpression' ? child(node, 'callee') : undefined;
    if (callee?.type !== 'MemberExpression' || child(callee, 'object')?.type !== 'ThisExpression') {
      return;
    }

    if (identifierName(child(callee, 'property')) === name) {
      found.push({
        contract: identifierName(callArguments(node)[0]),
        text: reader.text(node),
        ...reader.at(node),
      });
    }
  });

  return found;
}

function thisField(node: Node | undefined): string | null {
  if (node?.type !== 'MemberExpression' || child(node, 'object')?.type !== 'ThisExpression') {
    return null;
  }

  return identifierName(child(node, 'property'));
}

function enqueueCalls(reader: Reader, body: Node | undefined): EnqueueFact[] {
  const found: EnqueueFact[] = [];

  walk(body, (node) => {
    const callee = node.type === 'CallExpression' ? child(node, 'callee') : undefined;
    const field = callee?.type === 'MemberExpression' ? thisField(child(callee, 'object')) : null;

    if (field !== null && identifierName(child(callee as Node, 'property')) === 'enqueue') {
      found.push({ field, contract: identifierName(callArguments(node)[0]), ...reader.at(node) });
    }
  });

  return found;
}

function classMethods(cls: Node): Node[] {
  return nodes(child(cls, 'body')?.['body']).filter((member) => member.type === 'MethodDefinition');
}

function methodFact(reader: Reader, method: Node): MethodFact[] {
  const name = keyName(method);

  return name === null ? [] : [{ name, ...reader.at(method) }];
}

function pieceFact(reader: Reader, cls: Node, exported: boolean): PieceFact {
  const declaration = callArguments(child(cls, 'superClass') as Node)[0];
  const methods = classMethods(cls);
  const body = child(cls, 'body');

  return {
    className: identifierName(child(cls, 'id')) ?? '',
    exported,
    needs: needFacts(declaration),
    config: configFacts(reader, declaration),
    emits: identifiers(property(declaration, 'emits')),
    policy: (literalValue(property(declaration, 'policy')) as Record<string, unknown> | undefined) ?? {},
    handles: methods.flatMap((method) => handleFacts(reader, method)),
    serves: [
      ...decoratorCalls(cls, 'Serve').map((call) => serveFact(reader, call, null)),
      ...methods.flatMap((method) =>
        decoratorCalls(method, 'Serve').map((call) => serveFact(reader, call, method)),
      ),
    ],
    emitCalls: thisCalls(reader, body, 'emit'),
    requestCalls: thisCalls(reader, body, 'request'),
    enqueueCalls: enqueueCalls(reader, body),
    methods: methods.flatMap((method) => methodFact(reader, method)),
    ...reader.at(cls),
  };
}

interface TopLevel {
  readonly node: Node;
  readonly exported: boolean;
}

function topLevel(body: readonly Node[]): TopLevel[] {
  return body.flatMap((statement): TopLevel[] => {
    if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') {
      const declaration = child(statement, 'declaration');

      return declaration === undefined ? [] : [{ node: declaration, exported: true }];
    }

    return [{ node: statement, exported: false }];
  });
}

function classFacts(reader: Reader, items: readonly TopLevel[]): Pick<FileFacts, 'contracts' | 'pieces'> {
  const classes = items.filter((item) => item.node.type === 'ClassDeclaration');
  const contracts: ContractFact[] = [];
  const pieces: PieceFact[] = [];

  for (const { node, exported } of classes) {
    const base = calleeName(child(node, 'superClass'));
    const kind = base === null ? undefined : FACTORY_KINDS[base];

    if (kind !== undefined) {
      contracts.push(contractFact(reader, node, kind, exported));
    }

    if (base === 'Piece') {
      pieces.push(pieceFact(reader, node, exported));
    }
  }

  return { contracts, pieces };
}

function errorStatuses(table: Node | undefined): ErrorStatus[] {
  return properties(table).flatMap((p) => {
    const name = keyName(p);
    const value = child(p, 'value');
    const status = numberValue(property(value, 'status'));
    const code = stringValue(property(value, 'code'));

    if (name === null || status === null || code === null) {
      return [];
    }

    return [{ name, status, code }];
  });
}

function issueRenames(table: Node | undefined): IssueRename[] {
  return properties(table).flatMap((p) => {
    const from = keyName(p);
    const to = stringValue(child(p, 'value'));

    return from === null || to === null ? [] : [{ from, to }];
  });
}

function tokenFact(call: Node, bindings: readonly string[]): TokenFact | null {
  const factory = calleeName(call);
  const options = callArguments(call)[0];

  if (factory !== 'http' && factory !== 'defineCapability') {
    return null;
  }

  return {
    bindings,
    factory: factory === 'http' ? 'http' : 'capability',
    name: stringValue(property(options, 'name')),
    guards: identifiers(property(options, 'guards')),
    errors: errorStatuses(property(property(options, 'errors'), 'status')),
    inputErrors: errorStatuses(property(property(options, 'errors'), 'input')),
    issueCodes: issueRenames(property(property(property(options, 'errors'), 'input'), 'issueCodes')),
    idempotencyErrors: errorStatuses(property(property(options, 'errors'), 'idempotency')),
    customEnvelope: property(property(options, 'errors'), 'envelope') !== undefined,
    responseHeaders: property(options, 'responseHeaders') !== undefined,
    log: property(options, 'log') !== undefined,
  };
}

function defaultExportName(body: readonly Node[]): string | null {
  const statement = body.find((s) => s.type === 'ExportDefaultDeclaration');

  return statement === undefined ? null : identifierName(child(statement, 'declaration'));
}

function declaredTokens(items: readonly TopLevel[], defaultName: string | null): TokenFact[] {
  return items
    .filter((item) => item.node.type === 'VariableDeclaration')
    .flatMap((item) => nodes(item.node['declarations']))
    .flatMap((declarator) => {
      const name = identifierName(child(declarator, 'id'));
      const init = child(declarator, 'init');

      if (name === null || init === undefined) {
        return [];
      }

      const bindings = name === defaultName ? [name, 'default'] : [name];

      return tokenFact(init, bindings) ?? [];
    });
}

function defaultToken(body: readonly Node[]): TokenFact[] {
  const statement = body.find((s) => s.type === 'ExportDefaultDeclaration');
  const declaration = statement === undefined ? undefined : child(statement, 'declaration');

  const token = declaration?.type === 'CallExpression' ? tokenFact(declaration, ['default']) : null;

  return token === null ? [] : [token];
}

function exportedNames(reader: Reader, body: readonly Node[]): ExportFact[] {
  return body.flatMap((statement): ExportFact[] => {
    if (statement.type === 'ExportDefaultDeclaration') {
      return [{ name: 'default', ...reader.at(statement) }];
    }

    if (statement.type !== 'ExportNamedDeclaration' || statement['exportKind'] === 'type') {
      return [];
    }

    const declaration = child(statement, 'declaration');
    if (declaration === undefined) {
      return nodes(statement['specifiers'])
        .filter((s) => s['exportKind'] !== 'type')
        .map((s) => ({ name: identifierName(child(s, 'exported')) ?? '', ...reader.at(s) }));
    }

    return declaredValueNames(declaration).map((name) => ({ name, ...reader.at(statement) }));
  });
}

function reexportsOf(statement: Node): ReexportFact[] {
  const specifier = stringValue(child(statement, 'source'));
  if (statement.type !== 'ExportNamedDeclaration' || specifier === null) {
    return [];
  }

  return nodes(statement['specifiers']).flatMap((s) => {
    const imported = identifierName(child(s, 'local'));
    const exported = identifierName(child(s, 'exported'));

    return imported === null || exported === null ? [] : [{ specifier, imported, exported }];
  });
}

function declaredValueNames(declaration: Node): string[] {
  if (declaration.type === 'TSInterfaceDeclaration' || declaration.type === 'TSTypeAliasDeclaration') {
    return [];
  }

  if (declaration.type === 'VariableDeclaration') {
    return nodes(declaration['declarations']).flatMap((d) => identifierName(child(d, 'id')) ?? []);
  }

  const name = identifierName(child(declaration, 'id'));

  return name === null ? [] : [name];
}

const EMPTY_FACTS = {
  parsed: false,
  imports: [],
  contracts: [],
  pieces: [],
  tokens: [],
  exports: [],
  reexports: [],
} as const;

export function extractFile(file: string, source: string): FileFacts {
  const parsed = parse(file, source);
  if (parsed === null) {
    return { file, ...EMPTY_FACTS };
  }

  const reader = readerOf(source);
  const body = parsed.program.body;
  const items = topLevel(body);

  return {
    file,
    parsed: true,
    imports: parsed.imports,
    ...classFacts(reader, items),
    tokens: [...declaredTokens(items, defaultExportName(body)), ...defaultToken(body)],
    exports: exportedNames(reader, body),
    reexports: body.flatMap(reexportsOf),
  };
}
