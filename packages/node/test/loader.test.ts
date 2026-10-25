import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatReport } from '@murmur/node';
import { busContractOf, Command, defineCapability, Event, Piece, type ContractClass } from 'murmur';

import { planCapabilities, type CapabilityEntry } from '../src/capabilities/registry.ts';
import type { ContractSource, ValidPiece } from '../src/loader/candidate.ts';
import { buildCatalog, catalogWarnings } from '../src/loader/catalog.ts';
import type { PieceDefinition } from '../src/loader/class-piece.ts';
import { parseFrontmatter } from '../src/loader/piece-id.ts';
import { buildReport } from '../src/loader/report.ts';
import { checkInternalScope, checkResponders, contractIdentityErrors } from '../src/loader/validate.ts';

class Secret extends Event({}, { name: 'billing.secret.computed' }) {}
class Rates extends Event({}, { name: 'rates.updated' }) {}
class Ask extends Command({}, {}, { name: 'billing.ask' }) {}
class Unused extends Piece() {}

interface Parts {
  readonly emits?: readonly ContractClass[];
  readonly handles?: readonly ContractClass[];
}

function pieceDefinition(parts: Parts = {}): PieceDefinition {
  return {
    pieceClass: Unused,
    config: {},
    needs: [],
    policy: {},
    emits: (parts.emits ?? []).map(busContractOf),
    handlers: (parts.handles ?? []).map((contract) => ({
      contract: busContractOf(contract),
      handle: () => undefined,
    })),
  };
}

function valid(id: string, definition: ValidPiece['definition']): ValidPiece {
  return {
    id,
    file: `/app/pieces/${id}/piece.ts`,
    dir: `/app/pieces/${id}`,
    title: id,
    summary: 's',
    parent: null,
    depth: 0,
    definition,
    errors: [],
    warnings: [],
  };
}

function entry(name: string, needs: string[] = []): CapabilityEntry {
  return {
    name,
    definition: defineCapability({ name, needs, start: () => ({}) as never }),
    file: undefined,
    origin: 'app',
  };
}

test('an internal contract used outside its subtree is a contracts error', () => {
  const sources: ContractSource[] = [
    {
      contract: busContractOf(Secret),
      file: '/app/pieces/billing/contracts.ts',
      visibility: 'internal',
      scope: 'billing',
    },
  ];
  const inside = valid('billing/invoice', pieceDefinition({ emits: [Secret], handles: [Rates] }));
  const outside = valid('shipping/label', pieceDefinition({ handles: [Secret] }));
  checkInternalScope([inside, outside], sources);
  assert.deepEqual(inside.errors, []);
  assert.equal(outside.errors[0]?.code, 'internal-contract-scope');
});

test('two contract objects with one name are a contract-identity error', () => {
  class Twin extends Event({}, { name: 'rates.updated' }) {}
  const errors = contractIdentityErrors(
    [{ contract: busContractOf(Rates), file: '/app/contracts/rates.ts', visibility: 'public', scope: null }],
    [valid('a', pieceDefinition({ emits: [Twin] }))],
    [],
  );
  assert.equal(errors[0]?.code, 'contract-identity');
});

test('a second responder for one request contract is an error on the second piece', () => {
  const first = valid('a', pieceDefinition({ handles: [Ask] }));
  const second = valid('b', pieceDefinition({ handles: [Ask] }));
  checkResponders([first, second]);
  assert.deepEqual(first.errors, []);
  assert.match(second.errors[0]?.message ?? '', /more than one responder: a, b/);
});

test('catalog warnings: handled-never-emitted, requested-never-handled, no prefix check on derived names', () => {
  const pieces = [
    valid('billing/sim/rates', pieceDefinition({ emits: [Rates, Ask] })),
    valid('audit', pieceDefinition({ handles: [Secret] })),
  ];
  const codes = catalogWarnings(buildCatalog([], pieces, [])).map((w) => `${w.code}:${w.subject}`);
  assert.deepEqual(codes.toSorted(), [
    'emitted-never-subscribed:rates.updated',
    'requested-never-handled:billing.ask',
    'subscribed-never-emitted:billing.secret.computed',
  ]);
});

test('capabilities are planned in dependency order, stable by name, and cycles are needs errors', () => {
  const entries = new Map(
    [entry('kv', ['sqlite']), entry('sqlite'), entry('cache', ['kv']), entry('ids2')].map((e) => [e.name, e]),
  );
  assert.deepEqual(
    planCapabilities(entries, ['cache', 'ids2']).order.map((e) => e.name),
    ['ids2', 'sqlite', 'kv', 'cache'],
  );
  const cyclic = new Map([entry('a', ['b']), entry('b', ['a'])].map((e) => [e.name, e]));
  assert.match(planCapabilities(cyclic, ['a']).errors[0]?.message ?? '', /cycle: a → b → a/);
});

test('frontmatter yields title and summary; none yields nulls', () => {
  assert.deepEqual(parseFrontmatter('---\ntitle: T\nsummary: one line\n---\n# x'), {
    title: 'T',
    summary: 'one line',
  });
  assert.deepEqual(parseFrontmatter('# no frontmatter'), { title: null, summary: null });
});

test('the human report groups errors by piece with phase and issue paths', () => {
  const candidate = {
    ...valid('cfg', pieceDefinition()),
    errors: [
      {
        phase: 'config' as const,
        message: 'cfg.config: invalid config',
        issues: [{ message: 'expected number', path: ['port'] }],
      },
    ],
  };
  const text = formatReport(buildReport([candidate], [], [], { contracts: [], capabilities: [] }));
  assert.match(text, /boot failed: 1 errors in 1 pieces/);
  assert.match(text, /cfg {2}\/app\/pieces\/cfg\/piece\.ts/);
  assert.match(text, /config: cfg\.config: invalid config/);
  assert.match(text, /port: expected number/);
});
