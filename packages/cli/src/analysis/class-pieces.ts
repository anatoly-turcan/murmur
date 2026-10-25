import { relative } from 'node:path';

import { everyFormatProblem, everyInputProblem, retryKindProblem, retryLadderProblem } from 'murmur';

import { isWithin, pieceNodes } from './discover.ts';
import type { CallFact, FileFacts, HandleFact, PieceFact, ServeFact } from './extract.ts';
import { idempotentProblems } from './idempotent.ts';
import type { StaticApp, StaticContract } from './static-app.ts';
import type { FolderNode, HandlerInfo, PieceInfo, Repo, ServeInfo } from './types.ts';

export type Severity = 'error' | 'warn';

export interface StaticFinding {
  readonly rule: string;
  readonly severity: Severity;
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly message: string;
}

export interface ClassPieces {
  readonly pieces: readonly PieceInfo[];
  readonly ids: ReadonlySet<string>;
  readonly findings: readonly StaticFinding[];
}

interface PieceScope {
  readonly app: StaticApp;
  readonly node: FolderNode;
  readonly file: string;
  readonly findings: StaticFinding[];
}

const LIFECYCLE_HOOKS: Readonly<Record<string, string>> = { onstart: 'onStart', onstop: 'onStop' };

function report(
  scope: PieceScope,
  rule: string,
  severity: Severity,
  at: { line: number; col: number },
  message: string,
): void {
  scope.findings.push({ rule, severity, file: scope.file, line: at.line, col: at.col, message });
}

function contractNamed(
  scope: PieceScope,
  identifier: string | null,
  at: { line: number; col: number },
  what: string,
): StaticContract | null {
  if (identifier === null) {
    return null;
  }

  const contract = scope.app.contractIn(scope.file, identifier);
  if (contract === null || contract.kind === 'model') {
    report(
      scope,
      'handler-unknown-contract',
      'error',
      at,
      `${scope.node.id} ${what} ${identifier}, which is not a contract class imported from #contracts/* or an ancestor contracts.ts`,
    );

    return null;
  }

  if (contract.scope !== null && !isWithin(scope.node.id, contract.scope)) {
    report(
      scope,
      'internal-contract-scope',
      'error',
      at,
      `${contract.wireName ?? identifier} is internal to pieces/${contract.scope} and cannot be used by ${scope.node.id}`,
    );
  }

  if (contract.wireName === null && !scope.app.contracts.includes(contract)) {
    report(scope, 'wire-name', 'error', at, contract.nameError ?? `${identifier} has no wire name`);
  }

  return contract;
}

function wireNames(contracts: readonly (StaticContract | null)[]): string[] {
  return [...new Set(contracts.flatMap((c) => c?.wireName ?? []))];
}

function everyProblem(handle: HandleFact, contract: StaticContract): [string, string] | null {
  if (handle.every === null) {
    return null;
  }

  const format = handle.everyLiteral ? everyFormatProblem(handle.every) : undefined;
  if (format !== undefined) {
    return ['every-format', format];
  }

  const required = (contract.requiredFields ?? []).length > 0;
  const input = everyInputProblem(contract.className, contract.kind, contract.kind === 'command' && required);

  return input === undefined ? null : ['every-input', input];
}

function checkJobOptions(scope: PieceScope, handle: HandleFact, contract: StaticContract): void {
  const every = everyProblem(handle, contract);
  if (every !== null) {
    report(scope, every[0], 'error', handle, every[1]);
  }

  const ladder = retryProblem(handle, contract);
  if (ladder !== undefined) {
    report(scope, 'retry-ladder', 'error', handle, ladder);
  }
}

function retryProblem(handle: HandleFact, contract: StaticContract): string | undefined {
  if (!handle.hasRetry) {
    return undefined;
  }

  const kind = retryKindProblem(contract.className, contract.kind);
  if (kind !== undefined) {
    return kind;
  }

  return handle.retryLiteral ? retryLadderProblem(handle.retry) : undefined;
}

function handlerInfo(handle: HandleFact, wireName: string, contract: StaticContract): HandlerInfo {
  const info = { contract: wireName, hasReply: contract.kind !== 'event', exported: true };

  return handle.every === null ? info : { ...info, every: handle.every };
}

function handlers(scope: PieceScope, fact: PieceFact): HandlerInfo[] {
  return fact.handles.flatMap((handle) => {
    const contract = contractNamed(scope, handle.contract, handle, 'handles');
    if (contract?.wireName == null) {
      return [];
    }

    checkJobOptions(scope, handle, contract);

    return [handlerInfo(handle, contract.wireName, contract)];
  });
}

function enqueued(scope: PieceScope, fact: PieceFact): string[] {
  const jobFields = new Set(
    fact.needs
      .filter((need) => need.token !== null && scope.app.tokenIn(scope.file, need.token)?.name === 'jobs')
      .map((need) => need.field),
  );
  const contracts = fact.enqueueCalls
    .filter((call) => jobFields.has(call.field) && call.contract !== null)
    .map((call) => scope.app.contractIn(scope.file, call.contract as string));

  return wireNames(contracts);
}

function emits(scope: PieceScope, fact: PieceFact): string[] {
  return wireNames(fact.emits.map((identifier) => contractNamed(scope, identifier, fact, 'emits')));
}

function undeclaredEmits(scope: PieceScope, fact: PieceFact): void {
  for (const call of fact.emitCalls) {
    if (call.contract !== null && !fact.emits.includes(call.contract)) {
      report(
        scope,
        'emit-undeclared',
        'error',
        call,
        `this.emit(${call.contract}) but ${call.contract} is not in the emits of Piece({ … })`,
      );
    }
  }
}

function requests(scope: PieceScope, calls: readonly CallFact[]): string[] {
  return wireNames(
    calls.map((call) => (call.contract === null ? null : scope.app.contractIn(scope.file, call.contract))),
  );
}

function needs(scope: PieceScope, fact: PieceFact): { names: string[]; fields: string[] } {
  const resolved = fact.needs.map((need) => {
    const token = need.token === null ? null : scope.app.tokenIn(scope.file, need.token);

    return { field: need.field, name: token?.name ?? need.token ?? need.field };
  });

  return { names: resolved.map((n) => n.name), fields: resolved.map((n) => `${n.field}=${n.name}`) };
}

function pathParams(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1));
}

function checkParams(
  scope: PieceScope,
  serve: ServeFact,
  key: string,
  contract: StaticContract | null,
): void {
  if (contract === null || contract.fields === null || serve.path === null) {
    return;
  }

  for (const param of pathParams(serve.path)) {
    if (!contract.fields.includes(param)) {
      report(
        scope,
        'binding-param-not-in-input',
        'error',
        serve,
        `route ${key}: path param :${param} is not a field of ${contract.className} input`,
      );
    }
  }
}

function checkParamKeys(scope: PieceScope, serve: ServeFact, key: string): void {
  if (serve.path === null) {
    return;
  }

  const params = pathParams(serve.path);
  const allowed =
    params.length === 0 ? 'the path has no params' : `use one of ${params.map((p) => `:${p}`).join(', ')}`;

  for (const name of serve.paramKeys.filter((k) => !params.includes(k))) {
    report(
      scope,
      'binding-param-not-in-input',
      'error',
      serve,
      `route ${key}: req.read params key \`${name}\` is not a path param; ${allowed}`,
    );
  }
}

function guardNames(scope: PieceScope, file: string, identifiers: readonly string[]): string[] {
  return identifiers.flatMap((identifier) => scope.app.contractIn(file, identifier)?.wireName ?? []);
}

function effectiveGuards(
  defaults: readonly string[],
  skip: readonly string[],
  extra: readonly string[],
): string[] {
  const kept = defaults.filter((guard) => !skip.includes(guard));

  return [...kept, ...extra.filter((guard) => !kept.includes(guard))];
}

function tokenProblem(scope: PieceScope, identifier: string | null): string | null {
  if (identifier === null) {
    return 'its binding is not <token>.<verb>(path) on an imported http token';
  }

  if (scope.app.tokenIn(scope.file, identifier)?.http != null) {
    return null;
  }

  const origin = scope.app.importIn(scope.file, identifier);
  if (origin === null) {
    return `${identifier} is not imported; import the http token from '#capabilities/<name>'`;
  }

  if (origin.file === null) {
    return `${identifier} comes from '${origin.specifier}', which resolves to no file of the app (see package.json "imports")`;
  }

  return `${identifier} from '${origin.specifier}' is not an http({ … }) token`;
}

function routeProblem(serve: ServeFact): string | null {
  if (serve.verb === null) {
    return `${serve.maker ?? 'the binding'} is not a route maker (get, post, put, patch, delete, raw)`;
  }

  return serve.path === null ? 'the route path is not a string literal' : null;
}

function unresolved(scope: PieceScope, serve: ServeFact): boolean {
  const problem = tokenProblem(scope, serve.token) ?? routeProblem(serve);
  if (problem !== null) {
    report(
      scope,
      'serve-unresolved',
      'error',
      serve,
      `${serve.text}: ${problem}; check, catalog and ctx cannot see this route`,
    );
  }

  return problem !== null;
}

function guardRequests(scope: PieceScope, serve: ServeFact, token: string, key: string): void {
  const [verb = '', path = ''] = key.split(' ');
  for (const call of serve.requests) {
    const contract = call.contract === null ? null : scope.app.contractIn(scope.file, call.contract);
    if (contract?.kind === 'guard') {
      const name = contract.className;
      report(
        scope,
        'guard-requested-directly',
        'warn',
        call,
        `\`this.request(${name})\` in a serve method; admission belongs on the route: \`${token}.${verb.toLowerCase()}('${path}', { guards: [${name}] })\``,
      );
    }
  }
}

function checkIdempotent(scope: PieceScope, serve: ServeFact, key: string, guards: readonly string[]): void {
  if (serve.idempotent === null) {
    return;
  }

  const route = {
    key,
    verb: serve.verb ?? '',
    raw: serve.maker === 'raw',
    guards,
    idempotent: serve.idempotent,
  };

  for (const [rule, message] of idempotentProblems(scope.app, route)) {
    report(scope, rule, 'error', serve, message);
  }
}

function idempotentInfo(serve: ServeFact): ServeInfo['idempotent'] {
  if (serve.idempotent === null) {
    return null;
  }

  return { scope: serve.idempotent.scope ?? [], ttlMs: serve.idempotent.ttlMs };
}

function serveInfo(scope: PieceScope, serve: ServeFact): ServeInfo | null {
  const token = serve.token === null ? null : scope.app.tokenIn(scope.file, serve.token);
  if (token?.http == null || serve.verb === null || serve.path === null) {
    return null;
  }

  const key = `${serve.verb} ${serve.path}`;
  const shorthand = contractNamed(scope, serve.contract, serve, `serves ${key} with`);
  const defaults = guardNames(scope, token.http.file, token.http.guards);
  const skip = guardNames(scope, scope.file, serve.skip);
  const extra = guardNames(scope, scope.file, serve.guards);
  checkParams(scope, serve, key, shorthand);
  checkParamKeys(scope, serve, key);
  guardRequests(scope, serve, serve.token ?? token.name, key);
  const guards = effectiveGuards(defaults, skip, extra);
  checkIdempotent(scope, serve, key, guards);

  for (const input of serve.inputs) {
    checkParams(scope, serve, key, scope.app.contractIn(scope.file, input));
  }

  return {
    transport: 'http',
    token: token.name,
    key,
    method: serve.method,
    contract: shorthand?.wireName ?? null,
    status: serve.status,
    guards,
    skipped: skip,
    meta: serve.meta,
    metaText: serve.metaText,
    idempotent: idempotentInfo(serve),
    line: serve.line,
  };
}

function hookTypos(scope: PieceScope, fact: PieceFact): void {
  for (const method of fact.methods) {
    const hook = LIFECYCLE_HOOKS[method.name.toLowerCase().replace(/[_-]/g, '')];
    if (hook !== undefined && hook !== method.name) {
      report(
        scope,
        'lifecycle-hook-typo',
        'warn',
        method,
        `${fact.className}.${method.name} looks like the lifecycle hook ${hook}; the runtime calls ${hook} only`,
      );
    }
  }
}

function exportFindings(scope: PieceScope, facts: FileFacts, fact: PieceFact): void {
  if (!fact.exported) {
    report(
      scope,
      'piece-class-missing',
      'error',
      fact,
      `${scope.node.id}: export the piece class (export class ${fact.className} extends Piece(…))`,
    );
  }

  for (const named of facts.exports.filter((e) => e.name !== fact.className)) {
    report(
      scope,
      'piece-exports-one-class',
      'error',
      named,
      `piece.ts exports ${named.name} besides ${fact.className}; move it to a private file in the folder`,
    );
  }
}

function classInfo(scope: PieceScope, facts: FileFacts, fact: PieceFact): PieceInfo {
  exportFindings(scope, facts, fact);
  undeclaredEmits(scope, fact);
  hookTypos(scope, fact);
  const need = needs(scope, fact);
  const resolvable = fact.serves.filter((serve) => !unresolved(scope, serve));
  const serves = resolvable.flatMap((serve) => serveInfo(scope, serve) ?? []);
  const forwarded = serves.flatMap((serve) => serve.contract ?? []);

  return {
    id: scope.node.id,
    file: scope.file,
    error: null,
    hasPieceClass: true,
    className: fact.className,
    handlers: handlers(scope, fact),
    emits: emits(scope, fact),
    needs: need.names,
    needFields: need.fields,
    config: fact.config,
    policy: fact.policy,
    requests: [...new Set([...requests(scope, fact.requestCalls), ...forwarded])],
    jobs: enqueued(scope, fact),
    serves,
    unresolvedServes: fact.serves.length - resolvable.length,
  };
}

function missingInfo(scope: PieceScope): PieceInfo {
  report(
    scope,
    'piece-class-missing',
    'error',
    { line: 1, col: 1 },
    `${scope.node.id}: piece.ts has no exported class extending Piece(…)`,
  );

  return {
    id: scope.node.id,
    file: scope.file,
    error: null,
    hasPieceClass: false,
    handlers: [],
    emits: [],
    needs: [],
    config: [],
    policy: {},
  };
}

function pieceInfo(scope: PieceScope): PieceInfo | null {
  const facts = scope.app.facts(scope.file);
  const [first, ...others] = facts.pieces;

  if (!facts.parsed) {
    return null;
  }

  if (first === undefined) {
    return missingInfo(scope);
  }

  for (const other of others) {
    report(
      scope,
      'one-piece-per-folder',
      'error',
      other,
      `${scope.node.id}: piece.ts declares ${first.className} and ${other.className}; one piece per folder`,
    );
  }

  return classInfo(scope, facts, first);
}

export function classPieces(repo: Repo, app: StaticApp): ClassPieces {
  const findings: StaticFinding[] = [];
  const pieces = pieceNodes(repo).flatMap(
    (node) => pieceInfo({ app, node, file: node.pieceFile as string, findings }) ?? [],
  );

  return { pieces, ids: new Set(pieces.map((p) => p.id)), findings };
}

export function relativeFinding(root: string, finding: StaticFinding): StaticFinding {
  return { ...finding, file: relative(root, finding.file) };
}
