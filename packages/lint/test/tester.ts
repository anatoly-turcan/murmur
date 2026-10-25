import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { RuleTester } from 'oxlint/plugins-dev';

RuleTester.describe = describe;
RuleTester.it = it;

export const fixtureApp = join(import.meta.dirname, 'fixtures/app');

export function inApp(path: string): string {
  return join(fixtureApp, path);
}

export function runRule(name: string, rule: unknown, cases: RuleTester.TestCases): void {
  assert.ok(cases.valid.length >= 3, `${name} has at least 3 valid cases`);
  assert.ok(cases.invalid.length >= 3, `${name} has at least 3 invalid cases`);
  new RuleTester().run(name, rule as never, cases);
}
