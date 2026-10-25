import { isBuiltin } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';

import { listOf, statementsOf } from '../ast.ts';
import { isRelative, onImports, resolveFrom } from '../imports.ts';
import { nearestManifest } from '../manifest.ts';
import { isInside, isTestFile } from '../paths.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

const IO_MODULES = new Set([
  'fs',
  'net',
  'http',
  'https',
  'http2',
  'dns',
  'tls',
  'dgram',
  'sqlite',
  'child_process',
  'worker_threads',
  'cluster',
  'os',
  'process',
  'vm',
]);

const PURE_PACKAGES = new Set(['zod', 'murmur', '@murmur/node/lib']);
const PURE_ALIASES = ['#contracts/', '#lib/'];
const CAPABILITY = '`capabilities/<name>/capability.ts`';
const IO_ADVICE = `lib modules are pure. Move the I/O to a capability (${CAPABILITY}) and keep the formatting here`;
const ALLOWED =
  'a lib module imports only `node:*` without I/O, `zod`, `murmur`, `@murmur/node/lib`, `#contracts/*` and `#lib/*`';

interface LibFile {
  readonly root: string;
  readonly lib: string;
  readonly path: string;
}

function libFileOf(filename: string): LibFile | null {
  const manifest = nearestManifest(filename);
  if (manifest === undefined || !/\.[cm]?tsx?$/.test(filename) || isTestFile(filename)) {
    return null;
  }

  const root = dirname(manifest.path);
  const lib = join(root, 'lib');

  return isInside(lib, filename) ? { root, lib, path: relative(root, filename).split(sep).join('/') } : null;
}

function isIoModule(specifier: string): boolean {
  const name = specifier.replace(/^node:/, '').split('/')[0] ?? '';

  return IO_MODULES.has(name);
}

function isPure(specifier: string): boolean {
  if (isBuiltin(specifier)) {
    return true;
  }

  return PURE_PACKAGES.has(specifier) || PURE_ALIASES.some((prefix) => specifier.startsWith(prefix));
}

function relativeMessage(file: LibFile, filename: string, specifier: string): string {
  const target = resolveFrom(filename, specifier);
  const alias = isInside(file.lib, target)
    ? `#lib/${relative(file.lib, target)
        .split(sep)
        .join('/')
        .replace(/\.[cm]?tsx?$/, '')}`
    : '#lib/<module>';

  return `${file.path} imports \`${specifier}\`; reach another lib module as \`${alias}\``;
}

function importMessage(file: LibFile, filename: string, specifier: string): string | null {
  if (isRelative(specifier)) {
    return relativeMessage(file, filename, specifier);
  }

  if ((isBuiltin(specifier) && isIoModule(specifier)) || specifier.startsWith('#capabilities/')) {
    return `${file.path} imports \`${specifier}\`; ${IO_ADVICE}`;
  }

  return isPure(specifier) ? null : `${file.path} imports \`${specifier}\`; ${ALLOWED}`;
}

function declarationOf(statement: AstNode): AstNode | undefined {
  return statement.type === 'ExportNamedDeclaration' ? (statement.declaration ?? undefined) : statement;
}

function stateNames(statement: AstNode): string[] {
  const declaration = declarationOf(statement);
  if (declaration?.type !== 'VariableDeclaration' || declaration.kind === 'const') {
    return [];
  }

  return listOf<AstNode>(Reflect.get(declaration, 'declarations')).map((d) => d.id?.name ?? '…');
}

function checkState(context: RuleContext, file: LibFile, program: AstNode): void {
  for (const statement of statementsOf(program)) {
    for (const name of stateNames(statement)) {
      context.report({
        node: statement,
        message: `${file.path} declares top-level \`let ${name}\`; lib modules hold no state. Use \`const\`, or keep the state in a capability (${CAPABILITY})`,
      });
    }
  }
}

function create(context: RuleContext): Visitors {
  const file = libFileOf(context.filename);
  if (file === null) {
    return {};
  }

  return {
    ...onImports((node, specifier) => {
      const message = importMessage(file, context.filename, specifier);
      if (message !== null) {
        context.report({ node, message });
      }
    }),
    Program(node) {
      checkState(context, file, node);
    },
  };
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'lib/** modules are pure: no I/O node modules, no #capabilities, no top-level let; imports node:*, zod, murmur, @murmur/node/lib, #contracts/*, #lib/*',
    },
  },
  create,
} satisfies Rule;
