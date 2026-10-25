import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import plugin from '../src/plugin.ts';
import { root } from './oxlint.ts';

type Config = { rules?: Record<string, unknown>; overrides?: { rules: Record<string, unknown> }[] };

function murmurRules(config: Config): string[] {
  const all = [config.rules ?? {}, ...(config.overrides ?? []).map((o) => o.rules)].flatMap((rules) =>
    Object.keys(rules),
  );

  return [
    ...new Set(all.filter((rule) => rule.startsWith('murmur/')).map((rule) => rule.slice('murmur/'.length))),
  ];
}

test('the plugin ships exactly the rules the preset and the root config enable', () => {
  const preset = JSON.parse(readFileSync(join(root, 'packages/lint/preset.json'), 'utf8')) as Config;
  const rootConfig = JSON.parse(readFileSync(join(root, '.oxlintrc.json'), 'utf8')) as Config;
  const enabled = new Set([...murmurRules(preset), ...murmurRules(rootConfig)]);
  assert.equal(plugin.meta.name, 'murmur');
  assert.deepEqual(Object.keys(plugin.rules).toSorted(), [...enabled].toSorted());
  assert.equal(enabled.size, 23);
});
