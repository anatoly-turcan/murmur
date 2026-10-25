import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Command {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VerifyOptions {
  readonly registry: string;
  readonly dir: string;
  readonly version: string;
  readonly run: (command: Command) => CommandResult;
  readonly env?: NodeJS.ProcessEnv;
}

export const APP_WORKSPACE_TEMPLATE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'cli',
  'src',
  'templates',
  'app',
  'pnpm-workspace.yaml.tmpl',
);

export const PROBE_FILE = 'probe.ts';

export const PROBE_OUTPUT = 'decorated probe ran';

const PROBE_SOURCE = `function mark(_value: unknown, context: ClassDecoratorContext): void {
  context.addInitializer(() => console.log('${PROBE_OUTPUT}'))
}

@mark
class Probe {}

new Probe()
`;

const IGNORED_BUILDS = /ignored[ _]build/i;

function prepare(options: VerifyOptions): void {
  if (existsSync(options.dir) && readdirSync(options.dir).length > 0) {
    throw new Error(`${options.dir} exists and is not empty`);
  }

  mkdirSync(options.dir, { recursive: true });

  const manifest = {
    name: 'murmur-release-verify',
    private: true,
    type: 'module',
    dependencies: { '@murmur/cli': options.version, '@murmur/node': options.version },
  };

  writeFileSync(join(options.dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(options.dir, '.npmrc'), `registry=${options.registry}\n`);
  writeFileSync(join(options.dir, 'pnpm-workspace.yaml'), readFileSync(APP_WORKSPACE_TEMPLATE, 'utf8'));
  writeFileSync(join(options.dir, PROBE_FILE), PROBE_SOURCE);
}

function runOrThrow(
  options: VerifyOptions,
  file: string,
  args: readonly string[],
  what: string,
): CommandResult {
  const env = { ...options.env, XDG_CACHE_HOME: join(options.dir, '.cache') };
  const result = options.run({ file, args, cwd: options.dir, env });

  if (result.status !== 0) {
    throw new Error(`${what} failed (exit ${result.status})\n${result.stdout}${result.stderr}`);
  }

  return result;
}

function install(options: VerifyOptions): void {
  const result = runOrThrow(options, 'pnpm', ['install'], 'pnpm install');
  const output = `${result.stdout}${result.stderr}`;

  if (IGNORED_BUILDS.test(output)) {
    throw new Error(`pnpm install ignored a build script: check allowBuilds in the app template\n${output}`);
  }
}

function checkVersion(options: VerifyOptions): string {
  const bin = join(options.dir, 'node_modules', '.bin', 'murmur');
  const printed = runOrThrow(options, bin, ['--version'], 'murmur --version').stdout.trim();

  if (printed !== options.version) {
    throw new Error(`murmur --version printed ${printed}, expected ${options.version}`);
  }

  return printed;
}

export function publishedRegisterUrl(dir: string): string {
  const url = pathToFileURL(join(dir, 'node_modules', '@murmur', 'node', 'src', 'register', 'index.js'));

  url.searchParams.set('root', dir);

  return url.href;
}

function checkLoader(options: VerifyOptions): void {
  const args = ['--import', publishedRegisterUrl(options.dir), PROBE_FILE];
  const printed = runOrThrow(options, process.execPath, args, 'the published loader').stdout.trim();

  if (printed !== PROBE_OUTPUT) {
    throw new Error(`the published loader printed ${printed}, expected ${PROBE_OUTPUT}`);
  }
}

export function verifyCli(options: VerifyOptions): string {
  prepare(options);
  install(options);

  const printed = checkVersion(options);

  checkLoader(options);

  return printed;
}
