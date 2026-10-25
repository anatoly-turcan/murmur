import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';

import { cleanPackage, emitPackage } from '../src/emit.ts';

const root = mkdtempSync(join(tmpdir(), 'murmur-emit-'));
const pkg = join(root, 'node_modules', 'fixture');
after(() => rmSync(root, { recursive: true, force: true }));

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'fixture', type: 'module', bin: { fixture: './bin/fixture.js' } }),
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'esnext',
      module: 'nodenext',
      allowImportingTsExtensions: true,
      erasableSyntaxOnly: true,
      verbatimModuleSyntax: true,
      noEmit: true,
      types: [],
    },
  }),
  'src/index.ts': "import { greet } from './greet.ts'\nexport const message: string = greet('flock')\n",
  'src/greet.ts': 'export function greet(name: string): string {\n  return `hello ${name}`\n}\n',
  'src/greet.test.ts': "import { greet } from './greet.ts'\ngreet('x')\n",
  'bin/fixture.ts': "#!/usr/bin/env node\nimport { message } from '../src/index.ts'\nconsole.log(message)\n",
};

for (const [path, content] of Object.entries(FILES)) {
  mkdirSync(dirname(join(pkg, path)), { recursive: true });
  writeFileSync(join(pkg, path), content);
}

describe('emitPackage', () => {
  test('writes a .js beside every non-test .ts and rewrites relative .ts imports', () => {
    assert.equal(emitPackage(pkg), 3);
    assert.match(readFileSync(join(pkg, 'src/index.js'), 'utf8'), /from '\.\/greet\.js'/);
    assert.equal(existsSync(join(pkg, 'src/greet.test.js')), false);
    assert.equal(existsSync(join(pkg, 'tsconfig.pack.json')), false);
  });

  test('the emitted bin keeps its shebang and runs from inside node_modules', () => {
    assert.match(readFileSync(join(pkg, 'bin/fixture.js'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
    const run = spawnSync(process.execPath, [join(pkg, 'bin/fixture.js')], { encoding: 'utf8' });
    assert.equal(run.stdout.trim(), 'hello flock', run.stderr);
  });

  test('the .ts source cannot run from node_modules, which is why packages ship .js', () => {
    const run = spawnSync(process.execPath, [join(pkg, 'bin/fixture.ts')], { encoding: 'utf8' });
    assert.match(run.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
  });

  test('cleanPackage removes exactly the emitted files', () => {
    assert.equal(cleanPackage(pkg), 3);
    assert.equal(existsSync(join(pkg, 'src/index.js')), false);
    assert.equal(existsSync(join(pkg, 'src/index.ts')), true);
  });
});
