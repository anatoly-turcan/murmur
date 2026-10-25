import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { appConfig, makeApp, murmur } from './helpers.ts';

const APP = {
  'murmur.config.ts': appConfig(''),
  'murmur.yaml': 'capabilities:\n  sqlite:\n    path: sqlite:./app.db\n',
  'pieces/todos/schema.sql': 'CREATE TABLE todos (id TEXT PRIMARY KEY);\n',
  'migrations/001-seed.sql': "INSERT INTO todos VALUES ('seed');\n",
};

test('murmur migrate applies the default list once and reports what it applied', () => {
  using app = makeApp(APP);
  const first = murmur(['migrate', '--cwd', app.root]);
  const second = murmur(['migrate', '--cwd', app.root]);
  const json = murmur(['migrate', '--json', '--cwd', app.root]);
  const files = ['pieces/todos/schema.sql', 'migrations/001-seed.sql'];

  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    first.stdout.trim(),
    `migrate  ${join(app.root, 'app.db')}  applied 2: pieces/todos/schema.sql, migrations/001-seed.sql`,
  );
  assert.equal(second.stdout.trim(), `migrate  ${join(app.root, 'app.db')}  up to date (2 migrations)`);
  assert.deepEqual(json.json(), {
    kind: 'migrate',
    path: join(app.root, 'app.db'),
    files,
    applied: [],
    unmatched: [],
  });
});

test('murmur migrate names the failing file and exits 4', () => {
  using app = makeApp({ ...APP, 'migrations/001-seed.sql': 'INSERT INTO nowhere VALUES (1);\n' });
  const result = murmur(['migrate', '--cwd', app.root]);

  assert.equal(result.status, 4);
  assert.match(result.stderr, /migration migrations\/001-seed\.sql failed: .*no such table: nowhere/);
});

test('murmur --help lists migrate', () => {
  const result = murmur(['--help']);

  assert.match(result.stdout, /^ {2}migrate$/m);
});
