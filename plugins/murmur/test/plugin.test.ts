import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const pluginRoot = join(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(pluginRoot, path), 'utf8');
const json = (path: string): Record<string, unknown> => JSON.parse(read(path)) as Record<string, unknown>;

const AGENTS = ['piece-writer', 'piece-reviewer'];
const SKILLS = ['murmur-piece', 'murmur-contract', 'murmur-review'];
const TEXTS = [...AGENTS.map((a) => `agents/${a}.md`), ...SKILLS.map((s) => `skills/${s}/SKILL.md`)];
const CLI_BIN = join(pluginRoot, '..', '..', 'packages', 'cli', 'bin', 'murmur.ts');

function cliCommands(): Set<string> {
  const usage = spawnSync(process.execPath, [CLI_BIN, '--help'], { encoding: 'utf8' }).stdout;
  const names = usage
    .split('\n')
    .filter((line) => /^ {2}[a-z]/.test(line))
    .map((line) => line.trim().split(/\s/)[0] ?? '');

  return new Set(names);
}

const RETIRED =
  /m[c]p|murmur:\/\/|piece[_]context|check[_]boundaries|run[_]piece[_]tests|contract_schema|scaffold_(piece|contract)|emit_event|dev_status|tail_events|piece_logs/i;

function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  const pairs = block.split('\n').map((line) => /^([\w-]+):\s*(.*)$/.exec(line)?.slice(1, 3) ?? []);

  return Object.fromEntries(pairs.filter((pair) => pair.length === 2));
}

function sizing(text: string): string {
  return /<!-- sizing:start -->[\s\S]*<!-- sizing:end -->/.exec(text)?.[0] ?? '';
}

describe('plugin layout', () => {
  test('the manifest declares no agent server and the plugin ships no server config', () => {
    const manifest = json('.claude-plugin/plugin.json');
    assert.equal(manifest['name'], 'murmur');
    assert.deepEqual(Object.keys(manifest), ['name', 'version', 'description', 'license']);
    const entries = readdirSync(pluginRoot).filter((name) => name !== 'node_modules');
    assert.deepEqual(entries.toSorted(), [
      '.claude-plugin',
      'README.md',
      'agents',
      'hooks',
      'package.json',
      'skills',
      'test',
      'tsconfig.json',
    ]);
  });

  test('the README says how to allow the CLI commands the agents run', () => {
    const readme = read('README.md');
    assert.match(readme, /"Bash\(pnpm exec murmur \*\)"/);
    assert.match(readme, /"Bash\(pnpm test\*\)"/);
  });

  test('plugin.json and package.json carry the version of the framework packages', () => {
    const cli = JSON.parse(
      readFileSync(join(pluginRoot, '..', '..', 'packages', 'cli', 'package.json'), 'utf8'),
    ) as {
      version: string;
    };

    assert.equal(json('.claude-plugin/plugin.json')['version'], cli.version);
    assert.equal(json('package.json')['version'], cli.version);
  });

  test('hooks.json wires SessionStart, PostToolUse Edit|Write and Bash, and Stop to their scripts', () => {
    const hooks = json('hooks/hooks.json')['hooks'] as Record<
      string,
      { matcher?: string; hooks: { command: string }[] }[]
    >;
    const script = (event: string, matcher?: string): string =>
      hooks[event]?.find((entry) => entry.matcher === matcher)?.hooks[0]?.command ?? '';

    assert.match(script('PostToolUse', 'Edit|Write'), /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/check-edited\.ts/);
    assert.match(
      script('PostToolUse', 'Bash'),
      /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/check-bash\.ts" --debounce-ms \d+/,
    );
    assert.match(script('Stop'), /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/stop-check\.ts/);
    assert.match(script('SessionStart'), /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/session-start\.ts/);
  });

  test('every agent and skill names itself and describes when to use it', () => {
    for (const name of AGENTS) {
      assert.equal(frontmatter(read(`agents/${name}.md`))['name'], name);
    }

    for (const name of SKILLS) {
      assert.equal(frontmatter(read(`skills/${name}/SKILL.md`))['name'], name);
    }

    for (const file of [
      ...AGENTS.map((a) => `agents/${a}.md`),
      ...SKILLS.map((s) => `skills/${s}/SKILL.md`),
    ]) {
      assert.ok((frontmatter(read(file))['description'] ?? '').length > 40, file);
    }
  });

  test('agents and skills call murmur ctx first, then Read only the files the task touches', () => {
    for (const file of TEXTS) {
      const text = read(file).replaceAll(/\s+/g, ' ');
      assert.match(text, /`pnpm exec murmur ctx /, file);
      assert.match(text, /Reads? only the (other )?(folder )?files/, file);
      assert.match(text, /--with /, file);
    }
  });

  test('the CLI command set comes from murmur --help', () => {
    const commands = cliCommands();
    assert.ok(commands.has('ctx') && commands.has('test') && commands.has('start'), [...commands].join(' '));
    assert.equal(commands.has('global:'), false);
  });

  test('the murmur-piece skill writes every piece path as pieces/<id>', () => {
    const text = read('skills/murmur-piece/SKILL.md');
    assert.doesNotMatch(text, /<path>/);
    const commands = [...text.matchAll(/pnpm exec murmur (?:ctx|test|new piece|check)( [^ `]+)/g)].map(
      (m) => m[1],
    );
    assert.ok(commands.length > 0);

    for (const target of commands) {
      assert.equal(target, ' pieces/<id>');
    }
  });

  test('agents and skills name CLI commands only: no server tools or resources', () => {
    const cli = cliCommands();
    for (const file of TEXTS) {
      const text = read(file);
      assert.doesNotMatch(text, RETIRED, file);
      const commands = [...text.matchAll(/pnpm exec murmur ([a-z-]+)/g)].map((m) => m[1] ?? '');
      assert.ok(commands.length > 0, file);

      for (const command of commands) {
        assert.ok(cli.has(command), `${file}: murmur ${command} is not a CLI command`);
      }
    }
  });

  test('agents run with the built-in tools only, Bash included for the CLI', () => {
    assert.equal(frontmatter(read('agents/piece-writer.md'))['tools'], 'Bash, Read, Edit, Write, Glob, Grep');
    assert.equal(frontmatter(read('agents/piece-reviewer.md'))['tools'], 'Bash, Read, Glob, Grep');
  });

  test('both agents quote the sizing heuristics verbatim from the murmur-piece skill', () => {
    const source = sizing(read('skills/murmur-piece/SKILL.md'));
    assert.match(source, /one sentence without "and"/);

    for (const name of AGENTS) {
      assert.equal(sizing(read(`agents/${name}.md`)), source, name);
    }
  });
});
