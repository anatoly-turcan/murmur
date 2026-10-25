import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countDeps, countLockPackages } from '../lib/deps.ts'
import { classify, countLoc, countTestCases } from '../lib/loc.ts'

test('classify separates source, tests, migrations and noise', () => {
  assert.equal(classify('src/tasks/tasks.service.ts'), 'src')
  assert.equal(classify('pieces/tasks/claim/piece.ts'), 'src')
  assert.equal(classify('pieces/tasks/claim/piece.test.ts'), 'test')
  assert.equal(classify('pieces/tasks/scenario.test.ts'), 'test')
  assert.equal(classify('test/app.e2e-spec.ts'), 'test')
  assert.equal(classify('src/tasks/tasks.spec.ts'), 'test')
  assert.equal(classify('db/migrations/001_init.sql'), 'migration')
  assert.equal(classify('node_modules/x/index.js'), 'ignored')
  assert.equal(classify('dist/main.js'), 'ignored')
  assert.equal(classify('src/types.d.ts'), 'ignored')
  assert.equal(classify('README.md'), 'ignored')
})

test('countLoc skips blanks and comment-only lines', () => {
  const text = ['// header', 'const a = 1', '', '/**', ' * doc', ' */', 'export { a } // trailing'].join('\n')

  assert.equal(countLoc(text, 'a.ts'), 2)
  assert.equal(countLoc('-- note\nselect 1;\n', 'x.sql'), 1)
})

test('countTestCases finds it/test calls and node:test subtests, not identifiers ending in it', () => {
  const text = "test('a', () => {})\nit.skip('b', () => {})\ndescribe('c', () => { it('d', fn) })\nsubmit('x')\nawait t.test('nested', fn)"

  assert.equal(countTestCases(text), 4)
})

test('countDeps ignores workspace links and spots database drivers', () => {
  const deps = countDeps([
    { path: 'package.json', json: { dependencies: { '@nestjs/core': '11.0.0', pg: '8.0.0', local: 'workspace:*' }, devDependencies: { typescript: '7.0.2', pg: '8.0.0' } } },
    { path: 'pkgs/a/package.json', json: { dependencies: { '@nestjs/core': '11.0.0' } } },
  ])

  assert.equal(deps.direct_prod, 2)
  assert.equal(deps.direct_dev, 1)
  assert.deepEqual(deps.db_hints, ['pg'])
})

test('countLockPackages reads the project document of a multi-document pnpm lockfile', () => {
  const lock = [
    '---',
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    packageManagerDependencies: {}',
    'packages:',
    "  '@pnpm/exe@12.0.0':",
    '    resolution: {}',
    '---',
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies: {}',
    'packages:',
    '  autocannon@8.0.0:',
    '    resolution: {}',
    "  '@types/node@26.6.5':",
    '    resolution: {}',
    'snapshots:',
    '  autocannon@8.0.0: {}',
  ].join('\n')

  assert.equal(countLockPackages('pnpm-lock.yaml', lock), 2)
  assert.equal(countLockPackages('package-lock.json', JSON.stringify({ packages: { '': {}, 'node_modules/a': {}, 'node_modules/b': {} } })), 2)
})
