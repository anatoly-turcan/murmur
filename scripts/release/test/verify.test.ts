import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  APP_WORKSPACE_TEMPLATE,
  PROBE_FILE,
  PROBE_OUTPUT,
  publishedRegisterUrl,
  verifyCli,
  type Command,
} from '../src/verify.ts';

const scratch = mkdtempSync(join(tmpdir(), 'murmur-verify-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

interface Outputs {
  readonly version?: string;
  readonly install?: string;
  readonly probe?: string;
}

function stdoutOf(command: Command, outputs: Outputs): string {
  if (command.file.endsWith('murmur')) {
    return `${outputs.version ?? '0.1.0'}\n`;
  }

  if (command.file === process.execPath) {
    return `${outputs.probe ?? PROBE_OUTPUT}\n`;
  }

  return outputs.install ?? '';
}

function recorder(outputs: Outputs = {}) {
  const commands: Command[] = [];
  const run = (command: Command) => {
    commands.push(command);

    return { status: 0, stdout: stdoutOf(command, outputs), stderr: '' };
  };

  return { commands, run };
}

test('installs the cli from the registry in an isolated project, checks murmur --version and the loader', () => {
  const dir = join(scratch, 'ok');
  const { commands, run } = recorder();
  assert.equal(verifyCli({ registry: 'http://127.0.0.1:4873/', dir, version: '0.1.0', run }), '0.1.0');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies, {
    '@murmur/cli': '0.1.0',
    '@murmur/node': '0.1.0',
  });
  assert.equal(readFileSync(join(dir, '.npmrc'), 'utf8'), 'registry=http://127.0.0.1:4873/\n');
  assert.equal(
    readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'),
    readFileSync(APP_WORKSPACE_TEMPLATE, 'utf8'),
  );
  const [install, version, probe] = commands;
  assert.deepEqual([install?.file, install?.args], ['pnpm', ['install']]);
  assert.equal(install?.cwd, dir);
  assert.equal(install?.env['XDG_CACHE_HOME'], join(dir, '.cache'));
  assert.deepEqual(
    [version?.file, version?.args],
    [join(dir, 'node_modules', '.bin', 'murmur'), ['--version']],
  );
  assert.deepEqual(
    [probe?.file, probe?.args],
    [process.execPath, ['--import', publishedRegisterUrl(dir), PROBE_FILE]],
  );
  assert.match(readFileSync(join(dir, PROBE_FILE), 'utf8'), /^@mark$/m);
});

test('an install that ignored a build script fails', () => {
  const { run } = recorder({ install: 'Ignored build scripts: @swc/core\n' });
  assert.throws(
    () =>
      verifyCli({ registry: 'http://127.0.0.1:4873/', dir: join(scratch, 'ignored'), version: '0.1.0', run }),
    /pnpm install ignored a build script/,
  );
});

test('a published loader that does not run the decorated probe fails', () => {
  const { run } = recorder({ probe: '' });
  assert.throws(
    () =>
      verifyCli({
        registry: 'http://127.0.0.1:4873/',
        dir: join(scratch, 'no-loader'),
        version: '0.1.0',
        run,
      }),
    /the published loader printed , expected decorated probe ran/,
  );
});

test('a different version from the installed cli fails', () => {
  const { run } = recorder({ version: '0.0.9' });
  assert.throws(
    () =>
      verifyCli({ registry: 'http://127.0.0.1:4873/', dir: join(scratch, 'stale'), version: '0.1.0', run }),
    /murmur --version printed 0\.0\.9, expected 0\.1\.0/,
  );
});

function failingInstall() {
  return { status: 1, stdout: '', stderr: 'ERR_PNPM_FETCH_404' };
}

test('a failed install fails with its output', () => {
  const run = failingInstall;
  assert.throws(
    () =>
      verifyCli({ registry: 'http://127.0.0.1:4873/', dir: join(scratch, 'missing'), version: '0.1.0', run }),
    /pnpm install failed \(exit 1\)[\s\S]*ERR_PNPM_FETCH_404/,
  );
});

test('refuses a directory that is not empty', () => {
  const dir = join(scratch, 'busy');
  mkdirSync(dir);
  writeFileSync(join(dir, 'x'), '');
  const { commands, run } = recorder();
  assert.throws(
    () => verifyCli({ registry: 'http://127.0.0.1:4873/', dir, version: '0.1.0', run }),
    /not empty/,
  );
  assert.equal(commands.length, 0);
  assert.equal(existsSync(join(dir, 'package.json')), false);
});
