import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import {
  analyze,
  assembleContext,
  DOC_PAGES,
  docRef,
  resolveDocsDir,
  syncDocs,
} from '../src/analysis/index.ts';
import { copyApp, fixtureApp, packageRoot, repoRoot } from './helpers.ts';

const docsDir = join(repoRoot, 'docs');
const DOC_LINK = /(?:murmur:\/\/docs\/|(?<!\.agents\/)\bdocs\/)([a-z][a-z-]*)(?:\.md)?/g;
const DOC_REF_CALL = /docRef\('([a-z-]+)'/g;

function linkedPages(text: string): string[] {
  return [...text.matchAll(DOC_LINK), ...text.matchAll(DOC_REF_CALL)].map((m) => m[1] as string);
}

function filesUnder(patterns: readonly string[]): string[] {
  return patterns.flatMap((pattern) =>
    globSync(pattern, { cwd: repoRoot, exclude: (p) => p.includes('node_modules') }),
  );
}

function sizingBlock(text: string): string {
  return /<!-- sizing:start -->[\s\S]*<!-- sizing:end -->/.exec(text)?.[0] ?? '';
}

function tempDir(): { root: string; [Symbol.dispose](): void } {
  const root = mkdtempSync(join(tmpdir(), 'murmur-docs-'));

  return { root, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) };
}

describe('docs/', () => {
  test('the seven pages exist, each opens with a top-level heading, guides stay under ~250 lines', () => {
    assert.deepEqual([...DOC_PAGES].toSorted(), [
      'api-preview',
      'capability-authoring',
      'cli',
      'dev-protocol',
      'envelope',
      'ingress',
      'piece-authoring',
    ]);

    for (const page of DOC_PAGES) {
      const text = readFileSync(join(docsDir, `${page}.md`), 'utf8');
      const lines = text.split('\n').length;
      assert.match(text, /^# \S/, page);
      assert.ok(page === 'api-preview' || lines <= 260, `${page}.md has ${lines} lines`);
    }
  });

  test('piece-authoring.md quotes the sizing heuristics verbatim from the murmur-piece skill', () => {
    const skill = readFileSync(join(repoRoot, 'plugins/murmur/skills/murmur-piece/SKILL.md'), 'utf8');
    const page = readFileSync(join(docsDir, 'piece-authoring.md'), 'utf8');
    assert.match(sizingBlock(skill), /one sentence without "and"/);
    assert.equal(sizingBlock(page), sizingBlock(skill));
  });

  test('every docs link in the CLI, plugin agents/skills and the docs points at an existing page', () => {
    const files = filesUnder([
      'packages/cli/src/**/*.ts',
      'plugins/murmur/agents/*.md',
      'plugins/murmur/skills/*/SKILL.md',
      'docs/*.md',
    ]);
    const links = files.flatMap((file) =>
      linkedPages(readFileSync(join(repoRoot, file), 'utf8')).map((page) => ({ file, page })),
    );
    assert.ok(
      links.some((l) => l.file.startsWith('plugins/')),
      'the plugin links to the docs',
    );
    assert.ok(
      links.some((l) => l.file.startsWith('packages/cli/')),
      'the CLI links to the docs',
    );

    for (const { file, page } of links) {
      assert.ok(existsSync(join(docsDir, `${page}.md`)), `${file} links to missing docs/${page}.md`);
    }
  });
});

describe('docs resolver', () => {
  test('inside the monorepo the repo docs/ wins over a shipped copy', () => {
    assert.equal(resolveDocsDir(), docsDir);
  });

  test('outside the monorepo the copy shipped in @murmur/cli is used; without one there is none', () => {
    using tmp = tempDir();
    const cliPackage = join(tmp.root, 'node_modules', '@murmur', 'cli');
    assert.equal(resolveDocsDir(cliPackage), null);
    syncDocs(docsDir, join(cliPackage, 'docs'));
    assert.equal(resolveDocsDir(cliPackage), join(cliPackage, 'docs'));
  });

  test('docRef is a path relative to the caller that exists, else the page name', () => {
    const ref = docRef('piece-authoring', fixtureApp);
    assert.ok(!ref.startsWith('/'), ref);
    assert.ok(existsSync(resolve(fixtureApp, ref)), ref);
    assert.equal(docRef('piece-authoring', fixtureApp, null), 'piece-authoring.md');
  });

  test('an installed cli is linked through the app node_modules/@murmur/cli, not the pnpm store path', () => {
    using tmp = tempDir();
    const store = join(
      tmp.root,
      'node_modules',
      '.pnpm',
      '@murmur+cli@0.1.0',
      'node_modules',
      '@murmur',
      'cli',
    );
    syncDocs(docsDir, join(store, 'docs'));
    mkdirSync(join(tmp.root, 'node_modules', '@murmur'), { recursive: true });
    symlinkSync(store, join(tmp.root, 'node_modules', '@murmur', 'cli'), 'dir');
    const ref = docRef('piece-authoring', tmp.root, resolveDocsDir(store));
    assert.equal(ref, join('node_modules', '@murmur', 'cli', 'docs', 'piece-authoring.md'));
  });

  test('ctx rule 11 links the sizing heuristics by a path that exists from the app root', async () => {
    const result = assembleContext(await analyze(fixtureApp, {}), 'todos/create', {
      budget: null,
      include: [],
    });

    const rule = /^11\. .*heuristics in `([^`]+)`/m.exec(result.markdown);
    assert.ok(rule !== null, 'rule 11 names the heuristics page');
    assert.ok(existsSync(resolve(fixtureApp, rule[1] as string)), String(rule[1]));
  });
});

describe('shipped docs', () => {
  test('@murmur/cli publishes docs/, synced by prepack and kept out of git', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      files: string[];
      scripts: Record<string, string>;
    };
    assert.ok(manifest.files.includes('docs'));
    assert.equal(manifest.scripts['prepack']?.split(' && ')[0], 'node scripts/sync-docs.ts');
    assert.match(readFileSync(join(repoRoot, '.gitignore'), 'utf8'), /^packages\/cli\/docs\/$/m);
  });

  test('syncDocs copies exactly the eight pages, byte for byte, replacing stale copies', () => {
    using tmp = tempDir();
    writeFileSync(join(tmp.root, 'envelope.md'), 'stale\n');
    const written = syncDocs(docsDir, tmp.root);
    assert.equal(written.length, DOC_PAGES.length);

    for (const page of DOC_PAGES) {
      assert.equal(
        readFileSync(join(tmp.root, `${page}.md`), 'utf8'),
        readFileSync(join(docsDir, `${page}.md`), 'utf8'),
      );
    }
  });
});

const EXAMPLE_IMPORTS: Readonly<Record<string, string>> = {
  defineApp: "import { defineApp } from '@murmur/node';",
  sqlite: "import { sqlite } from '@murmur/node/capabilities';",
  createMemoryTransport: "import { createMemoryTransport } from '@murmur/transport-memory';",
  Piece: "import { Piece } from 'murmur';",
};

function policyExamples(): string[] {
  const pages = globSync('*.md', { cwd: docsDir }).map((page) => readFileSync(join(docsDir, page), 'utf8'));
  const fences = pages.flatMap((text) => [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] ?? ''));

  return fences.filter((code) => /\bpolicy: \{/.test(code));
}

function withImports(code: string): string {
  const used = Object.entries(EXAMPLE_IMPORTS).filter(
    ([name]) => new RegExp(`\\b${name}\\b`).test(code) && !new RegExp(`import[^;]*\\b${name}\\b`).test(code),
  );

  return [...used.map(([, line]) => line), '', code].join('\n');
}

describe('documented examples', () => {
  test('every policy example in docs/ type-checks with tsgo in an app', () => {
    const examples = policyExamples();
    assert.ok(examples.length > 0, 'docs carry a policy example');
    using app = copyApp(join(repoRoot, 'examples', 'todo-api'));
    mkdirSync(join(app.root, 'doc-examples'));
    examples.forEach((code, at) =>
      writeFileSync(join(app.root, 'doc-examples', `policy-${at}.ts`), withImports(code)),
    );
    writeFileSync(
      join(app.root, 'tsconfig.docs.json'),
      JSON.stringify({ extends: './tsconfig.json', include: ['doc-examples'] }),
    );
    const result = spawnSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.docs.json'], {
      cwd: app.root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});

interface PreviewBlock {
  readonly path: string;
  readonly code: string;
}

const PREVIEW_BLOCK = /^`([\w./-]+\.(?:ts|sql|yaml))`\n\n```\w+\n([\s\S]*?)```$/gm;

function previewBlocks(): PreviewBlock[] {
  const text = readFileSync(join(docsDir, 'api-preview.md'), 'utf8');

  return [...text.matchAll(PREVIEW_BLOCK)].map((m) => ({ path: m[1] as string, code: m[2] as string }));
}

describe('docs/api-preview.md', () => {
  test('every file block is the examples/todo-api file, byte for byte', () => {
    const app = join(repoRoot, 'examples', 'todo-api');
    const blocks = previewBlocks();
    assert.ok(blocks.length >= 15, `${blocks.length} file blocks`);

    for (const { path, code } of blocks) {
      assert.ok(existsSync(join(app, path)), `api-preview shows ${path}, which todo-api does not have`);
      assert.equal(code, readFileSync(join(app, path), 'utf8'), path);
    }
  });
});
