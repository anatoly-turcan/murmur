import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertMinorStrings, expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import type { Json } from '../lib/client.ts';
import { createProject, createTask, deleteOk, getOk, team, type Team, type User } from '../lib/fixtures.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

function postBudget(t: Team, budget: unknown) {
  return t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'Budgeted', budget });
}

async function summary(user: User, projectId: number): Promise<Json> {
  const s = await getOk(user, `/v1/projects/${projectId}/summary`);
  assertMinorStrings(s);

  return s;
}

async function budgets(t: Team, currency: string, amounts: string[]): Promise<Json[]> {
  const project = await createProject(t.owner, t.ws.id);
  for (const amount of amounts) await createTask(t.owner, project.id, { budget: { currency, amount } });

  return (await summary(t.owner, project.id)).budgets;
}

test('[H1] more fractional digits than the currency allows is 422 too_many_decimals', async () => {
  const t = await team();
  for (const budget of [
    { currency: 'JPY', amount: '100.5' },
    { currency: 'USD', amount: '1.005' },
    { currency: 'KWD', amount: '1.0001' },
    { currency: 'KRW', amount: '1.0' },
  ]) {
    expectValidation(await postBudget(t, budget), 'budget.amount', 'too_many_decimals');
  }
});

test('[H1] amount must be a JSON string, never a number', async () => {
  const t = await team();
  expectValidation(await postBudget(t, { currency: 'USD', amount: 120.5 }), 'budget.amount', 'invalid_type');
  expectValidation(await postBudget(t, { currency: 'USD', amount: 100 }), 'budget.amount', 'invalid_type');
});

test('[H1] output amount uses the currency decimals and amount_minor is a digit string', async () => {
  const t = await team();
  const cases: [string, string, string, string][] = [
    ['KWD', '1.234', '1.234', '1234'],
    ['USD', '0.1', '0.10', '10'],
    ['USD', '10', '10.00', '1000'],
    ['USD', '120.5', '120.50', '12050'],
    ['JPY', '100', '100', '100'],
    ['BHD', '0.5', '0.500', '500'],
    ['EUR', '0', '0.00', '0'],
  ];
  for (const [currency, input, amount, minor] of cases) {
    const res = await postBudget(t, { currency, amount: input });
    expectStatus(res, 201, `${currency} ${input}`);
    assert.deepEqual(res.body.budget, { currency, amount, amount_minor: minor }, `${currency} ${input}`);
    assertMinorStrings(res.body);
    const got = await getOk(t.owner, `/v1/tasks/${res.body.id}`);
    assert.deepEqual(got.budget, { currency, amount, amount_minor: minor });
  }
});

test('[H1] 15 integer digits are exact (beyond 2^53) and returned as strings', async () => {
  const t = await team();
  const res = await postBudget(t, { currency: 'USD', amount: '999999999999999.99' });
  expectStatus(res, 201);
  assert.deepEqual(res.body.budget, { currency: 'USD', amount: '999999999999999.99', amount_minor: '99999999999999999' });
  assert.match(res.text, /"amount_minor"\s*:\s*"99999999999999999"/);
});

test('[H1] unsupported currency, missing parts and unknown fields are rejected at the nested path', async () => {
  const t = await team();
  expectValidation(await postBudget(t, { currency: 'XYZ', amount: '1.00' }), 'budget.currency', 'unsupported_currency');
  expectValidation(await postBudget(t, { currency: 'USD' }), 'budget.amount', 'required');
  expectValidation(await postBudget(t, { amount: '1.00' }), 'budget.currency', 'required');
  expectValidation(await postBudget(t, { currency: 'USD', amount: '1.00', amount_minor: '100' }), 'budget.amount_minor', 'unknown_field');
});

test('[H1] malformed amount strings are 422 invalid_format', async () => {
  const t = await team();
  for (const amount of ['1e5', '-1', '1,5', '', '1.', '.5', ' 1x', '1234567890123456']) {
    expectValidation(await postBudget(t, { currency: 'USD', amount }), 'budget.amount', 'invalid_format');
  }
});

// SPEC 3.7: a pattern failure is reported as invalid_format alone, even with too many decimals.
test('[H1] an amount that breaks the pattern and has too many decimals is invalid_format only', async () => {
  const t = await team();
  for (const [currency, amount] of [['USD', '1.1234567'], ['JPY', '1.1234567'], ['KWD', '1.5e3'], ['USD', '-0.123']]) {
    const res = await postBudget(t, { currency, amount });
    expectError(res, 422, 'validation_failed', { path: 'budget.amount', code: 'invalid_format' }, { exactDetails: true });
  }
});

test('[H1] PATCH replaces or clears the budget; partial budget is rejected', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id, { budget: { currency: 'USD', amount: '5' } });
  const changed = await t.owner.client.patch(`/v1/tasks/${task.id}`, { budget: { currency: 'JPY', amount: '700' } });
  expectStatus(changed, 200);
  assert.deepEqual(changed.body.budget, { currency: 'JPY', amount: '700', amount_minor: '700' });
  expectValidation(await t.owner.client.patch(`/v1/tasks/${task.id}`, { budget: { amount: '1' } }), 'budget.currency', 'required');
  const cleared = await t.owner.client.patch(`/v1/tasks/${task.id}`, { budget: null });
  expectStatus(cleared, 200);
  assert.equal(cleared.body.budget, null);
});

test('[H2] USD mean is total / count rounded half away from zero', async () => {
  const t = await team();
  assert.deepEqual(await budgets(t, 'USD', ['3.33', '3.33', '3.34']), [
    { currency: 'USD', count: 3, total: '10.00', total_minor: '1000', mean: '3.33', mean_minor: '333' },
  ]);
  assert.deepEqual(await budgets(t, 'USD', ['0.02', '0.03']), [
    { currency: 'USD', count: 2, total: '0.05', total_minor: '5', mean: '0.03', mean_minor: '3' },
  ]);
});

test('[H2] zero-decimal and three-decimal currencies round on minor units', async () => {
  const t = await team();
  assert.deepEqual(await budgets(t, 'JPY', ['33', '33', '34']), [
    { currency: 'JPY', count: 3, total: '100', total_minor: '100', mean: '33', mean_minor: '33' },
  ]);
  assert.deepEqual(await budgets(t, 'JPY', ['50', '51']), [
    { currency: 'JPY', count: 2, total: '101', total_minor: '101', mean: '51', mean_minor: '51' },
  ]);
  assert.deepEqual(await budgets(t, 'KWD', ['0.001', '0.000']), [
    { currency: 'KWD', count: 2, total: '0.001', total_minor: '1', mean: '0.001', mean_minor: '1' },
  ]);
});

test('[H2] summary shape: counts, overdue, estimates, budgets by currency code, deleted tasks excluded', async () => {
  const t = await team();
  const p = await createProject(t.owner, t.ws.id);
  await createTask(t.owner, p.id, { budget: { currency: 'USD', amount: '1.50' }, estimate_minutes: 30, due_date: '2020-01-01' });
  await createTask(t.owner, p.id, { budget: { currency: 'KWD', amount: '2' }, status: 'in_progress', estimate_minutes: 45 });
  await createTask(t.owner, p.id, { budget: { currency: 'JPY', amount: '7' }, status: 'done', due_date: '2020-01-01' });
  await createTask(t.owner, p.id, { status: 'done' });
  const dropped = await createTask(t.owner, p.id, { budget: { currency: 'EUR', amount: '9.99' }, estimate_minutes: 1000, due_date: '2020-01-01' });
  await deleteOk(t.owner, `/v1/tasks/${dropped.id}`);

  const s = await summary(t.owner, p.id);
  assert.deepEqual(s, {
    project_id: p.id,
    task_counts: { open: 1, in_progress: 1, done: 2, total: 4 },
    overdue_count: 1,
    estimate_minutes_total: 75,
    budgets: [
      { currency: 'JPY', count: 1, total: '7', total_minor: '7', mean: '7', mean_minor: '7' },
      { currency: 'KWD', count: 1, total: '2.000', total_minor: '2000', mean: '2.000', mean_minor: '2000' },
      { currency: 'USD', count: 1, total: '1.50', total_minor: '150', mean: '1.50', mean_minor: '150' },
    ],
  });
});

test('[H2] empty project summary', async () => {
  const t = await team();
  const p = await createProject(t.owner, t.ws.id);
  assert.deepEqual(await summary(t.viewer, p.id), {
    project_id: p.id,
    task_counts: { open: 0, in_progress: 0, done: 0, total: 0 },
    overdue_count: 0,
    estimate_minutes_total: 0,
    budgets: [],
  });
});

test('[H2] aggregates stay exact beyond 64-bit integers', async () => {
  const t = await team();
  const amounts = Array.from({ length: 10 }, () => '999999999999999.999');
  assert.deepEqual(await budgets(t, 'KWD', amounts), [
    {
      currency: 'KWD',
      count: 10,
      total: '9999999999999999.990',
      total_minor: '9999999999999999990',
      mean: '999999999999999.999',
      mean_minor: '999999999999999999',
    },
  ]);
});
