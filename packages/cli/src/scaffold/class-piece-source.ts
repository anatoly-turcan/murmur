import { join } from 'node:path';

import type { ContractInfo } from '../analysis/types.ts';
import {
  claimsDelivery,
  classDir,
  contractImports,
  edgeInput,
  eventsOf,
  methodOfHandle,
  requestsOf,
  type ClassPiecePlan,
  type HandleSpec,
  type ServeSpec,
} from './class-piece-model.ts';
import { contractSource, importBlock, type ImportSpec } from './imports.ts';
import { BUILTIN_CAPABILITIES, CONFIG_TYPES } from './names.ts';
import type { PlannedFile } from './piece.ts';
import { sampleOf, tsEntry, tsLiteral, type JsonSchema } from './sample.ts';
import { render } from './template.ts';
import { tsTypeOf } from './ts-type.ts';

interface Member {
  readonly text: string;
  readonly murmur: readonly string[];
}

interface ObjectSchema {
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

const CLAIM_TABLE = 'CREATE TABLE IF NOT EXISTS handled (id TEXT PRIMARY KEY);\n';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function modelImports(plan: ClassPiecePlan): ImportSpec[] {
  return plan.handles.flatMap((h) =>
    h.outputModel === null
      ? []
      : [{ from: contractSource(plan.root, classDir(plan), h.contract), names: [`type ${h.outputModel}`] }],
  );
}

function capImports(plan: ClassPiecePlan): ImportSpec[] {
  return plan.needs.map((need) =>
    !BUILTIN_CAPABILITIES.has(need.cap)
      ? { from: `#capabilities/${need.cap}`, defaultName: need.cap }
      : { from: '@murmur/node/capabilities', names: [need.cap] },
  );
}

function methodOfServe(serve: ServeSpec): string {
  const words = serve.path
    .split('/')
    .filter((segment) => segment !== '' && !segment.startsWith(':'))
    .map((segment) =>
      segment.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? '').toUpperCase()),
    )
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1));

  return `${serve.verb}${words.length === 0 ? 'Root' : words.join('')}`;
}

function objectSchema(schema: unknown): ObjectSchema {
  const value = (schema ?? {}) as ObjectSchema & { readonly anyOf?: readonly ObjectSchema[] };

  return value.properties === undefined ? (value.anyOf?.[0] ?? {}) : value;
}

function fromInput(key: string, target: ObjectSchema, input: ObjectSchema): boolean {
  const own = input.properties?.[key];
  const required = input.required?.includes(key) ?? false;

  return required && IDENTIFIER.test(key) && JSON.stringify(own) === JSON.stringify(target.properties?.[key]);
}

function stub(schema: unknown, input: unknown): string {
  const value = sampleOf(schema as never);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return tsLiteral(value);
  }

  const target = objectSchema(schema);
  const own = objectSchema(input);
  const entries = Object.entries(value).map(([key, item]) =>
    fromInput(key, target, own) ? `${key}: input.${key}` : tsEntry(key, item),
  );

  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
}

function callLines(plan: ClassPiecePlan, skip: ContractInfo | null, input: unknown): string[] {
  const events = eventsOf(plan).map(
    (c) => `await this.emit(${c.className}, ${stub(c.schema?.payload, input)});`,
  );
  const requests = requestsOf(plan)
    .filter((c) => c !== skip)
    .map((c) => `await this.request(${c.className}, ${stub(c.schema?.payload, input)});`);

  return [...events, ...requests];
}

function indent(lines: readonly string[]): string {
  return lines.map((line) => (line === '' ? '' : `    ${line}`)).join('\n');
}

function replyStub(handle: HandleSpec): string {
  return stub(handle.contract.schema?.reply, handle.contract.schema?.payload);
}

function claimLines(plan: ClassPiecePlan, handle: HandleSpec): string[] {
  const db = plan.needs.find((n) => n.cap === 'sqlite')?.field ?? 'db';
  const reply = handle.contract.hasReply ? ` ${replyStub(handle)}` : '';

  return [
    `const claim = await this.${db}.run('INSERT OR IGNORE INTO handled (id) VALUES (?)', delivery.envelope.id);`,
    'if (claim.changes === 0) {',
    `  return${reply};`,
    '}',
  ];
}

function handleBody(plan: ClassPiecePlan, handle: HandleSpec, calls: readonly string[]): string[] {
  const reply = handle.contract.hasReply ? [`return ${replyStub(handle)};`] : [];
  const gap = calls.length > 0 && reply.length > 0 ? [''] : [];
  const work = [...calls, ...gap, ...reply];

  if (!claimsDelivery(plan, handle)) {
    return work;
  }

  const claim = claimLines(plan, handle);

  return work.length === 0 ? claim : [...claim, '', ...work];
}

function guardOutputSchema(contract: ContractInfo): unknown {
  const reply = contract.schema?.reply as { readonly anyOf?: readonly unknown[] } | undefined;

  return reply?.anyOf?.at(-1) ?? reply;
}

function guardBody(handle: HandleSpec): string[] {
  const admitted = stub(guardOutputSchema(handle.contract), handle.contract.schema?.payload);

  return [
    "if (input.headers['authorization'] === undefined) {",
    "  return reject(401, 'credentials required');",
    '}',
    '',
    `return ${admitted};`,
  ];
}

function guardMember(handle: HandleSpec): Member {
  const name = handle.contract.className;
  const output = handle.outputType ?? tsTypeOf(guardOutputSchema(handle.contract) as JsonSchema | undefined);
  const head = `  @Handle(${name})\n  async ${methodOfHandle(handle.contract)}(input: ${name}): Promise<${output} | Rejection> {`;

  return {
    text: `${head}\n${indent(guardBody(handle))}\n  }`,
    murmur: ['Handle', 'reject', 'type Rejection'],
  };
}

function outputOf(handle: HandleSpec): string {
  if (handle.outputType !== null) {
    return handle.outputType;
  }

  return handle.contract.hasReply
    ? tsTypeOf(handle.contract.schema?.reply as JsonSchema | undefined)
    : 'void';
}

function handleMember(plan: ClassPiecePlan, handle: HandleSpec, calls: readonly string[]): Member {
  if (handle.contract.kind === 'guard') {
    return guardMember(handle);
  }

  const name = handle.contract.className;
  const body = handleBody(plan, handle, calls);
  const claims = claimsDelivery(plan, handle);
  const input = body.some((line) => line.includes('input.')) ? 'input' : '_input';
  const params = claims ? `${input}: ${name}, delivery: Delivery` : `${input}: ${name}`;
  const output = outputOf(handle);
  const head = `  @Handle(${name})\n  async ${methodOfHandle(handle.contract)}(${params}): Promise<${output}> {`;
  const text = body.length === 0 ? `${head}}` : `${head}\n${indent(body)}\n  }`;

  return { text, murmur: claims ? ['Handle', 'type Delivery'] : ['Handle'] };
}

const BODY_VERBS: ReadonlySet<string> = new Set(['post', 'put', 'patch']);

function readPart(serve: ServeSpec): string {
  if (BODY_VERBS.has(serve.verb)) {
    return 'body';
  }

  return serve.path.includes('/:') ? 'params' : 'query';
}

function serveBody(serve: ServeSpec, input: ContractInfo | null, calls: readonly string[]): string[] {
  if (input === null) {
    const gap = calls.length > 0 ? [''] : [];

    return [...calls, ...gap, 'return req.reply({ path: req.path, params: req.params });'];
  }

  const name = input.className;
  const part = readPart(serve);

  return [
    `const { ${part} } = await req.read({ ${part}: ${name}.input });`,
    `const output = await this.request(${name}, ${part});`,
    ...(calls.length === 0 ? [] : ['', ...calls]),
    '',
    'return req.reply(output);',
  ];
}

function serveMember(serve: ServeSpec, input: ContractInfo | null, calls: readonly string[]): Member {
  const head = `  @Serve(web.${serve.verb}('${serve.path}'))\n  async ${methodOfServe(serve)}(req: WebRequest): Promise<HttpResult> {`;

  return { text: `${head}\n${indent(serveBody(serve, input, calls))}\n  }`, murmur: ['Serve'] };
}

function members(plan: ClassPiecePlan): Member[] {
  const input = edgeInput(plan);
  const calls = callLines(plan, input, undefined);
  const handles = plan.handles.map((h, i) =>
    handleMember(plan, h, i === 0 ? callLines(plan, input, h.contract.schema?.payload) : []),
  );
  const methodServes = plan.serves.filter((s) => s.contract === null);
  const serves = methodServes.map((s, i) =>
    serveMember(s, i === 0 ? input : null, i === 0 && handles.length === 0 ? calls : []),
  );

  return [...handles, ...serves];
}

function declaration(plan: ClassPiecePlan): string {
  const needs = plan.needs.map((n) => (n.field === n.cap ? n.cap : `${n.field}: ${n.cap}`)).join(', ');
  const config = plan.config.map((k) => `${k.key}: ${CONFIG_TYPES[k.type]}`).join(', ');
  const emits = eventsOf(plan)
    .map((c) => c.className)
    .join(', ');
  const lines = [
    ...(needs === '' ? [] : [`  needs: { ${needs} },`]),
    ...(config === '' ? [] : [`  config: { ${config} },`]),
    ...(emits === '' ? [] : [`  emits: [${emits}],`]),
  ];

  return lines.length === 0 ? '' : `{\n${lines.join('\n')}\n}`;
}

function decorators(plan: ClassPiecePlan): string {
  return plan.serves
    .flatMap((s) =>
      s.contract === null ? [] : [`@Serve(web.${s.verb}('${s.path}'), ${s.contract.className})\n`],
    )
    .join('');
}

function webImports(plan: ClassPiecePlan): ImportSpec[] {
  if (plan.serves.length === 0) {
    return [];
  }

  const methodServes = plan.serves.some((s) => s.contract === null);
  if (!methodServes) {
    return [{ from: '#capabilities/web', defaultName: 'web' }];
  }

  return [
    { from: '@murmur/node/capabilities', names: ['type HttpResult'] },
    { from: '#capabilities/web', defaultName: 'web', names: ['type WebRequest'] },
  ];
}

export function pieceFile(plan: ClassPiecePlan): PlannedFile {
  const built = members(plan);
  const murmurNames = [
    'Piece',
    ...built.flatMap((m) => m.murmur),
    ...(decorators(plan) === '' ? [] : ['Serve']),
  ];
  const served = plan.serves.flatMap((s) => s.contract ?? []);
  const input = edgeInput(plan);
  const imports: ImportSpec[] = [
    { from: 'murmur', names: [...new Set(murmurNames)] },
    ...capImports(plan),
    ...(plan.config.length === 0 ? [] : [{ from: 'zod', names: ['z'] }]),
    ...webImports(plan),
    ...contractImports(plan, [...plan.handles.map((h) => h.contract), ...plan.emits, ...served]),
    ...modelImports(plan),
    ...(input === null ? [] : contractImports(plan, [input])),
  ];

  return {
    path: join(classDir(plan), 'piece.ts'),
    content: render('piece/class-piece.ts.tmpl', {
      imports: importBlock(imports),
      decorators: decorators(plan),
      className: plan.className,
      declaration: declaration(plan),
      body: built.length === 0 ? '' : `\n${built.map((m) => `${m.text}\n`).join('\n')}`,
    }),
  };
}

export function schemaFiles(plan: ClassPiecePlan): PlannedFile[] {
  if (!plan.needs.some((n) => n.cap === 'sqlite')) {
    return [];
  }

  const claims = plan.handles.some((h) => claimsDelivery(plan, h));

  return [{ path: join(classDir(plan), 'schema.sql'), content: claims ? CLAIM_TABLE : '' }];
}
