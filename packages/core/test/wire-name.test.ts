import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { Event, MurmurError, type ContractClass } from 'murmur';
import { z } from 'zod';

import { domainOf } from '../src/model/naming.ts';

async function importWithoutStackFrames(
  specifier: string,
): Promise<{ module: Record<string, ContractClass>; limitDuring: number }> {
  const previous = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;

  try {
    const module = (await import(specifier)) as Record<string, ContractClass>;

    return { module, limitDuring: Error.stackTraceLimit };
  } finally {
    Error.stackTraceLimit = previous;
  }
}

test('wireName of contracts/todos.ts classes is todos.<Class> with Error.stackTraceLimit = 0', async () => {
  const { module: todos, limitDuring } = await importWithoutStackFrames('./fixtures/v2/contracts/todos.ts');

  assert.equal(limitDuring, 0);
  assert.equal(todos['CreateTodo']?.wireName, 'todos.CreateTodo');
  assert.equal(todos['GetTodo']?.wireName, 'todos.GetTodo');
  assert.equal(todos['TodoCreated']?.wireName, 'todos.TodoCreated');
  assert.match(todos['CreateTodo']?.file ?? '', /\/contracts\/todos\.ts$/);
});

test('an explicit { name } wins over the derived name', async () => {
  const todos = await import('./fixtures/v2/contracts/todos.ts');

  assert.equal(todos.TodoArchived.wireName, 'todos.archived');
  assert.equal(todos.TodoArchived.description, 'kept for v0.1');
});

test('nested contract folders, internal piece contracts and Guard() name after their defining file', async () => {
  const invoices = await import('./fixtures/v2/contracts/billing/invoices.ts');
  const sim = await import('./fixtures/v2/pieces/billing/sim/contracts.ts');
  const auth = await import('./fixtures/v2/contracts/auth.ts');

  assert.equal(invoices.Issue.wireName, 'billing.invoices.Issue');
  assert.equal(sim.RatesTicked.wireName, 'billing.sim.RatesTicked');
  assert.equal(auth.Authenticate.wireName, 'auth.Authenticate');
});

test('domainOf anchors on contracts/ and pieces/<group>/contracts.ts and nothing else', () => {
  assert.equal(domainOf('/app/contracts/todos.ts'), 'todos');
  assert.equal(domainOf('/app/contracts/billing/invoices.ts'), 'billing.invoices');
  assert.equal(domainOf('/app/pieces/billing/sim/contracts.ts'), 'billing.sim');
  assert.equal(domainOf('/srv/contracts/app/contracts/todos.js'), 'todos');
  assert.equal(domainOf('/app/pieces/todos/piece.ts'), undefined);
  assert.equal(domainOf('/app/pieces/billing/contracts/rates.ts'), undefined);
  assert.equal(domainOf('/srv/contracts/app/pieces/todos/piece.ts'), undefined);
  assert.equal(domainOf('/app/scratch/undeclared.ts'), undefined);
});

test('a contract defined outside contracts/ and pieces/<group>/contracts.ts asks for a home or { name }', () => {
  class Stray extends Event({ id: z.string() }) {}
  class Named extends Event({ id: z.string() }, { name: 'scratch.Named' }) {}

  assert.throws(() => Stray.wireName, {
    message:
      /^cannot derive a wire name for Stray from .*wire-name\.test\.ts: define it in contracts\/ or pieces\/<group>\/contracts\.ts, or pass \{ name \}$/,
  });
  assert.equal(Named.wireName, 'scratch.Named');
});

test('a class name outside the grammar or an invalid override is refused with the fix in the message', async () => {
  const { Odd_One } = await import('./fixtures/v2/contracts/odd.ts');

  assert.throws(() => Odd_One.wireName, {
    message: /"odd\.Odd_One" is not a valid name; rename the file or pass \{ name \}/,
  });
  assert.throws(() => Event({ id: z.string() }, { name: 'Todos.removed' }), MurmurError);
  assert.throws(() => Event({ id: z.string() }, { name: '$sys.nope' }), MurmurError);
});

test('a contract defined where no file frame exists asks for { name }', () => {
  const core = new URL('../src/index.ts', import.meta.url).href;
  const zod = import.meta.resolve('zod');
  const script = [
    `const { Event } = await import(${JSON.stringify(core)})`,
    `const { z } = await import(${JSON.stringify(zod)})`,
    'class Orphan extends Event({ id: z.string() }) {}',
    'try { Orphan.wireName } catch (error) { console.log(error.message) }',
  ].join('\n');
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });

  assert.equal(output.trim(), 'cannot derive a wire name for Orphan: pass { name } explicitly');
});
