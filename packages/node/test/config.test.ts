import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractViolationError } from 'murmur';
import { z } from 'zod';

import { buildEnvMap, envKey } from '../src/config/env-names.ts';
import { coerce, resolvePieceConfig } from '../src/config/resolve.ts';
import { parseYamlConfig, type YamlConfig } from '../src/config/sources.ts';

const SPEC_EXAMPLE = `# murmur.yaml — block style; every scalar is read as a string (failsafe schema), the coercion rule below types it
shared:
  currency: EUR
pieces:
  billing/invoice:
    taxRate: 0.2
    $policy:
      concurrency: 1
      timeoutMs: 5000
capabilities:
  sqlite:
    path: \${DATABASE_PATH:-./todo.db}      # \${VAR} interpolation on the raw text; error if missing without default
  http:
    port: \${PORT:-3000}
`;

const emptyYaml: YamlConfig = { shared: {}, pieces: {}, capabilities: {} };

describe('config precedence', () => {
  const schemas = { taxRate: z.number().default(0.1) };
  const yaml: YamlConfig = {
    shared: { taxRate: '0.2' },
    pieces: { 'billing/invoice': { taxRate: '0.3' } },
    capabilities: {},
  };
  const rows: Array<{ source: string; env: Record<string, string>; yaml: YamlConfig; expected: number }> = [
    {
      source: 'env piece',
      env: { MURMUR__BILLING_INVOICE__TAX_RATE: '0.5', MURMUR__TAX_RATE: '0.4' },
      yaml,
      expected: 0.5,
    },
    { source: 'env shared', env: { MURMUR__TAX_RATE: '0.4' }, yaml, expected: 0.4 },
    { source: 'yaml piece', env: {}, yaml, expected: 0.3 },
    { source: 'yaml shared', env: {}, yaml: { ...yaml, pieces: {} }, expected: 0.2 },
    { source: 'default', env: {}, yaml: emptyYaml, expected: 0.1 },
  ];

  for (const row of rows) {
    test(`${row.source} wins`, async () => {
      const resolved = await resolvePieceConfig('billing/invoice', schemas, { env: row.env, yaml: row.yaml });
      assert.deepEqual(resolved.errors, []);
      assert.deepEqual(resolved.config, { taxRate: row.expected });
      assert.ok(Object.isFrozen(resolved.config));
    });
  }

  test('an invalid value is a config violation naming the key', async () => {
    const resolved = await resolvePieceConfig('billing/invoice', schemas, {
      env: { MURMUR__TAX_RATE: 'lots' },
      yaml: emptyYaml,
    });

    assert.equal(resolved.errors.length, 1);
    const [error] = resolved.errors;
    assert.ok(error instanceof ContractViolationError);
    assert.equal(error.contract, 'billing/invoice.config');
    assert.equal(error.side, 'config');
    assert.deepEqual(error.issues[0]?.path, ['taxRate']);
  });
});

describe('raw-string-then-JSON coercion', () => {
  test('"0.2" becomes 0.2 for a number', async () => {
    assert.equal(await coerce('x.config', z.number(), '0.2'), 0.2);
  });

  test('a string schema keeps "123" and "01234"', async () => {
    assert.equal(await coerce('x.config', z.string(), '123'), '123');
    assert.equal(await coerce('x.config', z.string(), '01234'), '01234');
  });

  test(`'["a"]' becomes an array`, async () => {
    assert.deepEqual(await coerce('x.config', z.array(z.string()), '["a"]'), ['a']);
  });

  test('booleans decode from JSON', async () => {
    assert.equal(await coerce('x.config', z.boolean(), 'false'), false);
  });

  test('nested yaml values are coerced leaf by leaf', async () => {
    const schema = z.object({ max: z.number(), name: z.string(), tags: z.array(z.string()) });

    assert.deepEqual(await coerce('x.config', schema, { max: '5', name: '123', tags: ['a'] }), {
      max: 5,
      name: '123',
      tags: ['a'],
    });
  });

  test('a value no rule satisfies throws ContractViolationError', async () => {
    await assert.rejects(coerce('x.config', z.number(), 'abc'), ContractViolationError);
  });
});

describe('murmur.yaml', () => {
  test('${VAR:-x} interpolates the default when unset and the env value when set', () => {
    const text = 'shared:\n  region: ${REGION:-eu}\n';
    assert.deepEqual(parseYamlConfig(text, {}).shared, { region: 'eu' });
    assert.deepEqual(parseYamlConfig(text, { REGION: 'us' }).shared, { region: 'us' });
  });

  test('${VAR} without a default and without the variable is an error', () => {
    assert.throws(() => parseYamlConfig('shared:\n  secret: ${SECRET}\n', {}), /SECRET/);
  });

  test('zip: 01234 stays the string "01234"', () => {
    assert.deepEqual(parseYamlConfig('shared:\n  zip: 01234\n  ratio: 1.10\n', {}).shared, {
      zip: '01234',
      ratio: '1.10',
    });
  });

  test('the spec example parses', () => {
    assert.deepEqual(parseYamlConfig(SPEC_EXAMPLE, {}), {
      shared: { currency: 'EUR' },
      pieces: { 'billing/invoice': { taxRate: '0.2', $policy: { concurrency: '1', timeoutMs: '5000' } } },
      capabilities: { sqlite: { path: './todo.db' }, http: { port: '3000' } },
    });
  });

  test('a non-map section is an error', () => {
    assert.throws(() => parseYamlConfig('pieces: nope\n', {}), /pieces/);
  });
});

describe('env names', () => {
  test('keys become SCREAMING_SNAKE', () => {
    assert.equal(envKey('taxRate'), 'TAX_RATE');
    assert.equal(envKey('apiURL'), 'API_URL');
    assert.equal(envKey('apiUrl'), 'API_URL');
    assert.equal(envKey('port'), 'PORT');
  });

  test('two piece ids on one variable collide', () => {
    const map = buildEnvMap(
      [
        { id: 'billing/invoice', keys: ['taxRate'] },
        { id: 'billing-invoice', keys: ['taxRate'] },
      ],
      [],
    );
    assert.deepEqual(map.collisions, [
      {
        envVar: 'MURMUR__BILLING_INVOICE__TAX_RATE',
        subjects: ['billing/invoice.taxRate', 'billing-invoice.taxRate'],
      },
    ]);
  });

  test('apiUrl and apiURL collide on the piece and shared variables', () => {
    const map = buildEnvMap([{ id: 'web', keys: ['apiUrl', 'apiURL'] }], []);
    assert.deepEqual(
      map.collisions.map((c) => c.envVar),
      ['MURMUR__WEB__API_URL', 'MURMUR__API_URL'],
    );
  });

  test('one key shared by two pieces is one subject, not a collision', () => {
    const map = buildEnvMap(
      [
        { id: 'a', keys: ['currency'] },
        { id: 'b', keys: ['currency'] },
      ],
      [{ name: 'sqlite', keys: ['path'] }],
    );
    assert.deepEqual(map.collisions, []);
    assert.equal(map.subjects.get('MURMUR__CAP_SQLITE__PATH'), 'capabilities.sqlite.path');
  });
});
