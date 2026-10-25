import { join } from 'node:path';

import type { ContractInfo } from '../analysis/types.ts';
import {
  classDir,
  contractImports,
  edgeInput,
  eventsOf,
  fixturePath,
  requestsOf,
  sample,
  type ClassPiecePlan,
  type HandleSpec,
  type NeedSpec,
  type ServeSpec,
} from './class-piece-model.ts';
import { importBlock, type ImportSpec } from './imports.ts';
import { BUILTIN_CAPABILITIES, CONFIG_STUBS } from './names.ts';
import type { PlannedFile } from './piece.ts';
import { sampleOf } from './sample.ts';

interface TestSpec {
  readonly name: string;
  readonly lines: readonly string[];
  readonly imports: readonly ImportSpec[];
}

const JSON_VERBS = new Set(['post', 'put', 'patch']);

function unfaked(need: NeedSpec): boolean {
  return !BUILTIN_CAPABILITIES.has(need.cap);
}

function optionsText(plan: ClassPiecePlan): string {
  const needs = plan.needs.filter(unfaked).map((need) => `${need.field}: {} as never`);
  const config = plan.config.map((k) => `${k.key}: ${CONFIG_STUBS[k.type]}`);
  const fields = [
    ...(needs.length === 0 ? [] : [`needs: { ${needs.join(', ')} }`]),
    ...(config.length === 0 ? [] : [`config: { ${config.join(', ')} }`]),
  ];

  return fields.length === 0
    ? `testPiece(${plan.className})`
    : `testPiece(${plan.className}, { ${fields.join(', ')} })`;
}

function harnessLines(plan: ClassPiecePlan): string[] {
  return [`await using t = await ${optionsText(plan)};`];
}

function responders(contracts: readonly ContractInfo[]): string[] {
  return contracts.map((c) => {
    const reply = sample(c.schema?.reply);

    return `t.respond(${c.className}, () => ${reply.startsWith('{') ? `(${reply})` : reply});`;
  });
}

function guardTest(plan: ClassPiecePlan, contract: ContractInfo): TestSpec {
  const name = contract.className;
  const lines = [
    ...harnessLines(plan),
    `const refused = await t.deliverJson(${name}, fixture);`,
    `const admitted = await t.deliverJson(${name}, { ...fixture, headers: { authorization: 'Bearer x' } });`,
    '',
    'assert.equal(isRejection(refused) && refused.status, 401);',
    'assert.ok(!isRejection(admitted));',
  ];

  return {
    name: `${plan.id} refuses ${contract.name} without credentials and admits it with them`,
    lines,
    imports: [
      { from: 'murmur', names: ['isRejection'] },
      ...contractImports(plan, [contract]),
      { from: fixturePath(contract), defaultName: 'fixture', json: true },
    ],
  };
}

function handleTest(plan: ClassPiecePlan, handle: HandleSpec): TestSpec {
  const contract = handle.contract;
  if (contract.kind === 'guard') {
    return guardTest(plan, contract);
  }

  const name = contract.className;
  const deliver = `await t.deliverJson(${name}, fixture);`;
  const [event] = eventsOf(plan);
  const emitted =
    event === undefined
      ? 'assert.equal(t.emitted().length, 0);'
      : `assert.equal(t.emitted(${event.className}).length, 1);`;
  const lines = [
    ...harnessLines(plan),
    ...responders(requestsOf(plan)),
    contract.hasReply ? `const output = ${deliver}` : deliver,
    '',
    ...(contract.hasReply ? ['assert.notEqual(output, undefined);'] : []),
    emitted,
  ];

  return {
    name: `${plan.id} handles ${contract.name}`,
    lines,
    imports: [
      ...contractImports(plan, [contract, ...(event === undefined ? [] : [event]), ...requestsOf(plan)]),
      { from: fixturePath(contract), defaultName: 'fixture', json: true },
    ],
  };
}

function concretePath(path: string): string {
  return path.replace(/:\w+/g, '1');
}

function paramsOf(path: string): Set<string> {
  return new Set([...path.matchAll(/:(\w+)/g)].map((m) => m[1] as string));
}

function queryOf(serve: ServeSpec, input: ContractInfo | null): string {
  const value = input === null ? {} : sampleOf(input.schema?.payload as never);
  const params = paramsOf(serve.path);
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key, item]) => !params.has(key) && (typeof item !== 'object' || item === null),
  );

  return entries.length === 0
    ? ''
    : `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
}

function requestLines(serve: ServeSpec, input: ContractInfo | null): string[] {
  const url = `http://app${concretePath(serve.path)}`;
  if (!JSON_VERBS.has(serve.verb)) {
    const method = serve.verb === 'get' ? '' : `, { method: '${serve.verb.toUpperCase()}' }`;

    return [`const response = await t.fetch(new Request('${url}${queryOf(serve, input)}'${method}));`];
  }

  const body = input === null ? '{}' : sample(input.schema?.payload);

  return [
    `const body = JSON.stringify(${body});`,
    "const headers = { 'content-type': 'application/json' };",
    `const response = await t.fetch(new Request('${url}', { method: '${serve.verb.toUpperCase()}', body, headers }));`,
  ];
}

function serveInput(plan: ClassPiecePlan, serve: ServeSpec): ContractInfo | null {
  if (serve.contract !== null) {
    return serve.contract;
  }

  return serve === plan.serves.find((s) => s.contract === null) ? edgeInput(plan) : null;
}

function serveTest(plan: ClassPiecePlan, serve: ServeSpec): TestSpec {
  const input = serveInput(plan, serve);
  const answered = [...new Set([...(serve.contract === null ? [] : [serve.contract]), ...requestsOf(plan)])];
  const lines = [
    ...harnessLines(plan),
    ...responders(answered),
    ...requestLines(serve, input),
    '',
    serve.contract === null ? 'assert.equal(response.status, 200);' : 'assert.ok(response.ok);',
  ];

  return {
    name: `${plan.id} serves ${serve.verb.toUpperCase()} ${serve.path}`,
    lines,
    imports: contractImports(plan, answered),
  };
}

function shapeTest(plan: ClassPiecePlan): TestSpec {
  return {
    name: `${plan.id} is a piece class`,
    lines: [`assert.ok(isPieceClass(${plan.className}));`],
    imports: [{ from: 'murmur', names: ['isPieceClass'] }],
  };
}

function testSpecs(plan: ClassPiecePlan): TestSpec[] {
  const first = plan.handles[0];
  const serve = plan.serves[0];
  const specs = [
    ...(first === undefined ? [] : [handleTest(plan, first)]),
    ...(serve === undefined ? [] : [serveTest(plan, serve)]),
  ];

  return specs.length === 0 ? [shapeTest(plan)] : specs;
}

function testBlock(spec: TestSpec): string {
  const body = spec.lines.map((line) => (line === '' ? '' : `  ${line}`)).join('\n');

  return `test('${spec.name}', async () => {\n${body}\n});\n`;
}

export function testFile(plan: ClassPiecePlan): PlannedFile {
  const specs = testSpecs(plan);
  const usesHarness = specs.some((s) => s.lines.some((line) => line.includes('testPiece(')));
  const imports: ImportSpec[] = [
    { from: 'node:test', names: ['test'] },
    { from: 'node:assert/strict', defaultName: 'assert' },
    ...(usesHarness ? [{ from: '@murmur/node/testing', names: ['testPiece'] }] : []),
    ...specs.flatMap((s) => s.imports),
    { from: './piece.ts', names: [plan.className] },
  ];

  return {
    path: join(classDir(plan), 'piece.test.ts'),
    content: `${importBlock(imports)}\n\n${specs.map(testBlock).join('\n')}`,
  };
}

export function fixtureFiles(plan: ClassPiecePlan): PlannedFile[] {
  const first = plan.handles[0];
  if (first === undefined) {
    return [];
  }

  return [
    {
      path: join(classDir(plan), fixturePath(first.contract)),
      content: `${JSON.stringify(sampleOf(first.contract.schema?.payload as never), null, 2)}\n`,
    },
  ];
}
