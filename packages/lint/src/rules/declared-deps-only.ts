import { dirname, relative } from 'node:path';

import { isBare, onImports, packageNameOf } from '../imports.ts';
import { nearestManifest, type Manifest } from '../manifest.ts';
import { isPieceFile, isTestFile, piecesRoot } from '../paths.ts';
import type { Rule, RuleContext, Visitors } from '../types.ts';

const framework = new Set([
  'murmur',
  'murmur/testing',
  'zod',
  '@murmur/node',
  '@murmur/node/capabilities',
  '@murmur/node/lib',
  '@murmur/node/testing',
]);

const aliases = ['node:', '#contracts/', '#capabilities/', '#lib/'];

function isFramework(specifier: string): boolean {
  return framework.has(specifier) || aliases.some((prefix) => specifier.startsWith(prefix));
}

function isDeclared(declared: ReadonlySet<string>, specifier: string): boolean {
  return declared.has(specifier) || declared.has(packageNameOf(specifier));
}

function manifestDeps(manifest: Manifest | undefined, filename: string): readonly string[] {
  if (manifest === undefined) {
    return [];
  }

  if (isTestFile(filename)) {
    return [...manifest.dependencies, ...manifest.devDependencies];
  }

  return manifest.dependencies;
}

function undeclaredMessage(manifest: Manifest | undefined, filename: string): (specifier: string) => string {
  if (manifest === undefined) {
    return (specifier) => `"${specifier}" is not declared: no package.json found above this file`;
  }

  const appRoot = dirname(piecesRoot(filename) ?? filename);
  const lane = isTestFile(filename) ? 'dependencies or devDependencies' : 'dependencies';
  const path = relative(appRoot, manifest.path);

  return (specifier) => `"${specifier}" is not in ${lane} of ${path}; add it there or prefer a capability`;
}

function create(context: RuleContext): Visitors {
  if (!isPieceFile(context.filename)) {
    return {};
  }

  const manifest = nearestManifest(context.filename);
  const declared = new Set(manifestDeps(manifest, context.filename));
  const messageFor = undeclaredMessage(manifest, context.filename);

  return onImports((node, specifier) => {
    if (!isBare(specifier) || isFramework(specifier) || isDeclared(declared, specifier)) {
      return;
    }

    context.report({ node, message: messageFor(specifier) });
  });
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'piece files import only node:*, the framework, #contracts/*, #capabilities/*, #lib/* and dependencies of the nearest package.json',
    },
  },
  create,
} satisfies Rule;
