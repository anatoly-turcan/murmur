import { isBuiltin } from 'node:module';

import { isBare, onImports } from '../imports.ts';
import { isCoreFile } from '../paths.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

const message = 'core has zero node:* imports; move this to @murmur/node';
const nodeGlobals = new Set(['process', 'Buffer', 'require']);

function isGlobalProcess(node: AstNode): boolean {
  return (
    node.object?.type === 'Identifier' &&
    node.object.name === 'globalThis' &&
    !node.computed &&
    nodeGlobals.has(node.property?.name ?? '')
  );
}

function reportGlobals(context: RuleContext): void {
  for (const reference of context.sourceCode.scopeManager.globalScope?.through ?? []) {
    if (nodeGlobals.has(reference.identifier.name ?? '')) {
      context.report({ node: reference.identifier, message });
    }
  }
}

function create(context: RuleContext): Visitors {
  if (!isCoreFile(context.filename)) {
    return {};
  }

  return {
    ...onImports((node, specifier) => {
      if (isBare(specifier) && isBuiltin(specifier)) {
        context.report({ node, message });
      }
    }),
    MemberExpression(node) {
      if (isGlobalProcess(node)) {
        context.report({ node, message });
      }
    },
    'Program:exit': () => reportGlobals(context),
  };
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'packages/core/src has no node:* imports and no process/Buffer/require' },
  },
  create,
} satisfies Rule;
