import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

const pluginRoot = join(import.meta.dirname, '..');
const repoRoot = join(pluginRoot, '..', '..');
const HOOK = join(pluginRoot, 'hooks', 'check-edited.ts');
const BASH_HOOK = join(pluginRoot, 'hooks', 'check-bash.ts');
const STOP_HOOK = join(pluginRoot, 'hooks', 'stop-check.ts');
const SESSION_HOOK = join(pluginRoot, 'hooks', 'session-start.ts');

interface HookResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface HookOutput {
  readonly decision?: string;
  readonly reason?: string;
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: { readonly hookEventName: string; readonly additionalContext: string };
}

const contextMd = (id: string): string => `---\nsummary: Does ${id}.\n---\n\n# ${id}\n`;

const CONTRACTS = [
  "import { Event } from 'murmur';",
  "import { z } from 'zod';",
  '',
  'export class TodoCreated extends Event({ id: z.string() }) {}',
  '',
].join('\n');

const listener = (className: string, extra: string): string =>
  [
    "import { Handle, Piece } from 'murmur';",
    '',
    "import { TodoCreated } from '#contracts/todos';",
    '',
    `export class ${className} extends Piece() {`,
    '  @Handle(TodoCreated)',
    '  async seen(input: TodoCreated): Promise<void> {',
    `    this.log.info('seen', { id: input.id${extra} });`,
    '  }',
    '}',
    '',
  ].join('\n');

const LEAKY = listener('Leaky', ', token: process.env.TOKEN');

const BASE_FILES: Readonly<Record<string, string>> = {
  '.gitignore': 'node_modules\n.murmur\n',
  'package.json': `${JSON.stringify(
    {
      name: 'hook-app',
      private: true,
      type: 'module',
      imports: { '#contracts/*': './contracts/*.ts' },
      dependencies: { '@murmur/node': 'workspace:*', murmur: 'workspace:*', zod: '4.6.7' },
    },
    null,
    2,
  )}\n`,
  'tsconfig.json': '{ "extends": "@murmur/node/tsconfig.app.json", "include": ["pieces", "contracts"] }\n',
  '.oxlintrc.json': '{ "extends": ["./node_modules/@murmur/lint/preset.json"] }\n',
  'murmur.config.ts': [
    "import { defineApp } from '@murmur/node';",
    "import { createMemoryTransport } from '@murmur/transport-memory';",
    '',
    "export default defineApp({ name: 'hook', transport: () => createMemoryTransport() })",
    '',
  ].join('\n'),
  'contracts/todos.ts': CONTRACTS,
  'pieces/context.md': contextMd('pieces'),
  'pieces/todos/context.md': contextMd('todos'),
  'pieces/todos/audit/context.md': contextMd('todos/audit'),
  'pieces/todos/audit/piece.ts': listener('Audit', ''),
  'README.md': '# hook app\n',
};

function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=hook', '-c', 'user.email=hook@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
}

function makeApp(): { root: string; [Symbol.dispose](): void } {
  const root = mkdtempSync(join(tmpdir(), 'murmur-hook-'));
  symlinkSync(join(pluginRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFiles(root, {
    ...BASE_FILES,
    '.oxfmtrc.json': readFileSync(join(repoRoot, 'packages/lint/oxfmt.json'), 'utf8'),
  });
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);

  return { root, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) };
}

function event(cwd: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ session_id: `test-${crypto.randomUUID()}`, cwd, ...fields });
}

function payload(root: string, file: string, tool = 'Edit'): string {
  return JSON.stringify({
    session_id: 'test',
    hook_event_name: 'PostToolUse',
    cwd: root,
    tool_name: tool,
    tool_input: { file_path: join(root, file) },
    tool_response: { success: true },
  });
}

function runHook(stdin: string, debounceMs = 0, hook = HOOK): HookResult {
  const result = spawnSync(process.execPath, [hook, '--debounce-ms', String(debounceMs)], {
    input: stdin,
    encoding: 'utf8',
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runHookAsync(stdin: string, debounceMs: number): Promise<HookResult> {
  const child = spawn(process.execPath, [HOOK, '--debounce-ms', String(debounceMs)]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(stdin);

  return new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
}

function parsed(result: HookResult): HookOutput {
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout.trim(), '', `expected hook output, stderr:\n${result.stderr}`);

  return JSON.parse(result.stdout) as HookOutput;
}

describe('PostToolUse hook: murmur check on the edited piece', () => {
  test('a clean fixture produces no findings and no output', () => {
    using app = makeApp();
    const result = runHook(payload(app.root, 'pieces/todos/audit/piece.ts'));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });

  test('a new untracked piece reading process.env is reported back as a blocking finding', () => {
    using app = makeApp();
    writeFiles(app.root, {
      'pieces/todos/leaky/context.md': contextMd('todos/leaky'),
      'pieces/todos/leaky/piece.ts': LEAKY,
    });
    const output = parsed(runHook(payload(app.root, 'pieces/todos/leaky/piece.ts', 'Write')));
    assert.equal(output.decision, 'block');
    assert.match(output.reason ?? '', /murmur\/no-process-env/);
    assert.match(output.reason ?? '', /pieces\/todos\/leaky\/piece\.ts:\d+:\d+/);
    assert.doesNotMatch(output.reason ?? '', /pieces\/todos\/audit/);
  });

  test('a non-piece file under pieces/ maps to its piece folder', () => {
    using app = makeApp();
    writeFiles(app.root, {
      'pieces/todos/leaky/context.md': contextMd('todos/leaky'),
      'pieces/todos/leaky/piece.ts': LEAKY,
    });
    const output = parsed(runHook(payload(app.root, 'pieces/todos/leaky/context.md')));
    assert.match(output.reason ?? '', /murmur\/no-process-env/);
  });

  test('warnings only are summarised as additional context without blocking', () => {
    using app = makeApp();
    writeFiles(app.root, {
      'pieces/todos/quiet/context.md': '---\ntitle: quiet\n---\n\n# todos/quiet\n',
      'pieces/todos/quiet/piece.ts': listener('Quiet', ''),
    });
    const output = parsed(runHook(payload(app.root, 'pieces/todos/quiet/context.md', 'Write')));
    assert.equal(output.decision, undefined);
    assert.equal(output.hookSpecificOutput?.hookEventName, 'PostToolUse');
    assert.match(output.hookSpecificOutput?.additionalContext ?? '', /warn missing-summary/);
  });

  test('files outside pieces/ and contracts/ are ignored', () => {
    using app = makeApp();
    writeFiles(app.root, { 'pieces/todos/leaky/piece.ts': LEAKY });
    const result = runHook(payload(app.root, 'README.md'));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });

  test('an edit under capabilities/ checks the app and reports non-erasable syntax', () => {
    using app = makeApp();
    writeFiles(app.root, {
      'capabilities/clock/capability.ts': 'export enum Mode {\n  Fast,\n}\n',
    });
    const output = parsed(runHook(payload(app.root, 'capabilities/clock/capability.ts', 'Write')));
    assert.equal(output.decision, 'block');
    assert.match(output.reason ?? '', /murmur\/erasable-syntax-only/);
    assert.match(output.reason ?? '', /capabilities\/clock\/capability\.ts:\d+:\d+/);
  });

  test('files outside a murmur app and malformed input are ignored', () => {
    const outside = runHook(
      JSON.stringify({ tool_input: { file_path: join(tmpdir(), 'x', 'pieces', 'a.ts') } }),
    );
    assert.equal(outside.status, 0, outside.stderr);
    assert.equal(outside.stdout, '');
    const garbage = runHook('not json');
    assert.equal(garbage.status, 0, garbage.stderr);
    assert.equal(garbage.stdout, '');
  });

  test('concurrent edits in one piece folder are debounced into one check', async () => {
    using app = makeApp();
    writeFiles(app.root, {
      'pieces/todos/leaky/context.md': contextMd('todos/leaky'),
      'pieces/todos/leaky/piece.ts': LEAKY,
    });

    const results = await Promise.all([
      runHookAsync(payload(app.root, 'pieces/todos/leaky/piece.ts'), 1500),
      runHookAsync(payload(app.root, 'pieces/todos/leaky/context.md'), 1500),
    ]);

    for (const result of results) {
      assert.equal(result.status, 0, result.stderr);
    }

    const reported = results.filter((result) => result.stdout.includes('murmur/no-process-env'));
    assert.equal(reported.length, 1);
  });
});

describe('PostToolUse Bash hook: murmur check on pieces a command changed', () => {
  test('a Bash command that wrote a leaky piece is reported back as a blocking finding', () => {
    using app = makeApp();
    writeFiles(app.root, {
      'pieces/todos/leaky/context.md': contextMd('todos/leaky'),
      'pieces/todos/leaky/piece.ts': LEAKY,
    });
    const output = parsed(
      runHook(event(app.root, { tool_name: 'Bash', tool_input: { command: 'cp …' } }), 0, BASH_HOOK),
    );
    assert.equal(output.decision, 'block');
    assert.match(output.reason ?? '', /murmur check pieces\/todos\/leaky: 1 error/);
    assert.match(output.reason ?? '', /murmur\/no-process-env/);
  });

  test('a command that changed nothing under pieces/, contracts/ or capabilities/ produces no output', () => {
    using app = makeApp();
    writeFiles(app.root, { 'README.md': '# changed\n', 'notes/todo.txt': 'x\n' });
    const result = runHook(event(app.root, { tool_name: 'Bash' }), 0, BASH_HOOK);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });

  test('a file already seen dirty is not checked again until it changes', () => {
    using app = makeApp();
    writeFiles(app.root, {
      'pieces/todos/leaky/context.md': contextMd('todos/leaky'),
      'pieces/todos/leaky/piece.ts': LEAKY,
    });
    const input = event(app.root, { tool_name: 'Bash' });
    assert.equal(parsed(runHook(input, 0, BASH_HOOK)).decision, 'block');
    const again = runHook(input, 0, BASH_HOOK);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, '');
  });

  test('a session baseline from SessionStart skips files that were dirty before the session', () => {
    using app = makeApp();
    writeFiles(app.root, {
      'pieces/todos/leaky/context.md': contextMd('todos/leaky'),
      'pieces/todos/leaky/piece.ts': LEAKY,
    });
    const session = `test-${crypto.randomUUID()}`;
    const input = JSON.stringify({ session_id: session, cwd: app.root, tool_name: 'Bash' });
    runHook(
      JSON.stringify({ session_id: session, cwd: app.root, hook_event_name: 'SessionStart' }),
      0,
      SESSION_HOOK,
    );
    const result = runHook(input, 0, BASH_HOOK);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });
  test('a file the Edit hook already checked is not checked again by the next Bash command', () => {
    using app = makeApp();
    const session = `test-${crypto.randomUUID()}`;
    writeFiles(app.root, {
      'pieces/todos/leaky/context.md': contextMd('todos/leaky'),
      'pieces/todos/leaky/piece.ts': LEAKY,
    });
    runHook(
      JSON.stringify({ session_id: session, cwd: app.root, hook_event_name: 'SessionStart' }),
      0,
      SESSION_HOOK,
    );
    writeFiles(app.root, { 'pieces/todos/leaky/piece.ts': `${LEAKY}\n` });
    const edit = JSON.stringify({
      session_id: session,
      cwd: app.root,
      tool_name: 'Edit',
      tool_input: { file_path: join(app.root, 'pieces/todos/leaky/piece.ts') },
    });
    assert.equal(parsed(runHook(edit)).decision, 'block');
    const bash = runHook(
      JSON.stringify({ session_id: session, cwd: app.root, tool_name: 'Bash' }),
      0,
      BASH_HOOK,
    );
    assert.equal(bash.status, 0, bash.stderr);
    assert.equal(bash.stdout, '');
  });

  test('a git repo without a murmur app is left alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-plain-'));

    try {
      git(dir, ['init', '-q']);
      writeFiles(dir, { 'pieces/x/piece.ts': 'export {};\n' });
      const result = runHook(event(dir, { tool_name: 'Bash' }), 0, BASH_HOOK);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Stop hook: one murmur check of the app', () => {
  test('a dirty app with an error blocks the stop with the findings', () => {
    using app = makeApp();
    writeFiles(app.root, {
      'pieces/todos/leaky/context.md': contextMd('todos/leaky'),
      'pieces/todos/leaky/piece.ts': LEAKY,
    });
    const output = parsed(
      runHook(event(app.root, { hook_event_name: 'Stop', stop_hook_active: false }), 0, STOP_HOOK),
    );
    assert.equal(output.decision, 'block');
    assert.match(output.reason ?? '', /^murmur check \.: 1 error/);
    assert.match(output.reason ?? '', /pieces\/todos\/leaky\/piece\.ts:\d+:\d+ error murmur\/no-process-env/);
  });

  test('when Claude already continues for a stop hook the findings are shown, not blocked again', () => {
    using app = makeApp();
    writeFiles(app.root, {
      'pieces/todos/leaky/context.md': contextMd('todos/leaky'),
      'pieces/todos/leaky/piece.ts': LEAKY,
    });
    const output = parsed(
      runHook(event(app.root, { hook_event_name: 'Stop', stop_hook_active: true }), 0, STOP_HOOK),
    );
    assert.equal(output.decision, undefined);
    assert.match(output.systemMessage ?? '', /murmur\/no-process-env/);
  });

  test('a session baseline from SessionStart skips files that were dirty before the session', () => {
    using app = makeApp();
    const session = `test-${crypto.randomUUID()}`;
    writeFiles(app.root, {
      'pieces/todos/leaky/context.md': contextMd('todos/leaky'),
      'pieces/todos/leaky/piece.ts': LEAKY,
    });
    runHook(
      JSON.stringify({ session_id: session, cwd: app.root, hook_event_name: 'SessionStart' }),
      0,
      SESSION_HOOK,
    );
    const stop = JSON.stringify({
      session_id: session,
      cwd: app.root,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });
    const result = runHook(stop, 0, STOP_HOOK);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });

  test('an app with no changes under pieces/, contracts/ or capabilities/ is not checked', () => {
    using app = makeApp();
    writeFiles(app.root, { 'README.md': '# changed\n' });
    const result = runHook(event(app.root, { hook_event_name: 'Stop' }), 0, STOP_HOOK);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });
});

describe('SessionStart hook: three usage lines', () => {
  test('inside a murmur app it injects the ctx, check/test and skills lines, naming CLI commands only', () => {
    using app = makeApp();
    const output = parsed(runHook(event(app.root, { hook_event_name: 'SessionStart' }), 0, SESSION_HOOK));
    const lines = (output.hookSpecificOutput?.additionalContext ?? '').split('\n');
    assert.equal(output.hookSpecificOutput?.hookEventName, 'SessionStart');
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /`pnpm exec murmur ctx pieces\/<id>`.*before editing.*Read only the files/);
    assert.match(
      lines[1] ?? '',
      /`pnpm exec murmur check --fix pieces\/<id>`.*`pnpm exec murmur test pieces\/<id>`/,
    );
    assert.doesNotMatch(lines.join('\n'), /m[c]p|piece[_]context|run[_]piece[_]tests/i);
    assert.match(lines[2] ?? '', /\/murmur-piece.*\/murmur-contract.*\/murmur-review/);
  });

  test('outside a murmur app it says nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-plain-'));

    try {
      const result = runHook(event(dir, { hook_event_name: 'SessionStart' }), 0, SESSION_HOOK);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
