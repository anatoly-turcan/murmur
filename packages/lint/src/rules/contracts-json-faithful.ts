import { sep } from 'node:path';

import { calleeName } from '../ast.ts';
import { isGroupContracts } from '../paths.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

const message = 'contract schemas must be JSON-faithful and non-coercing; use strings/numbers/objects';
const zodCalls = ['date', 'bigint', 'map', 'set', 'instanceof', 'stringbool'];
const contractFactories = new Set(['Model', 'Query', 'Command', 'Event', 'Guard']);

function isContractsFile(filename: string): boolean {
  return filename.split(sep).slice(0, -1).includes('contracts') || isGroupContracts(filename);
}

function isContractCall(node: AstNode): boolean {
  return contractFactories.has(calleeName(node) ?? '');
}

function isZodMember(node: AstNode | undefined, names: readonly string[]): boolean {
  return (
    node?.type === 'MemberExpression' &&
    node.object?.type === 'Identifier' &&
    node.object.name === 'z' &&
    names.includes(node.property?.name ?? '')
  );
}

function isForbiddenCall(node: AstNode): boolean {
  const callee = node.callee;
  const isTransform = callee?.type === 'MemberExpression' && callee.property?.name === 'transform';

  return isTransform || isZodMember(callee, zodCalls);
}

function create(context: RuleContext): Visitors {
  if (!isContractsFile(context.filename)) {
    return {};
  }

  let depth = 0;

  return {
    CallExpression(node) {
      if (depth > 0 && isForbiddenCall(node)) {
        context.report({ node, message });
      }

      if (isContractCall(node)) {
        depth += 1;
      }
    },
    'CallExpression:exit'(node) {
      if (isContractCall(node)) {
        depth -= 1;
      }
    },
    MemberExpression(node) {
      if (depth > 0 && isZodMember(node, ['coerce'])) {
        context.report({ node, message });
      }
    },
  };
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'schemas inside Model/Query/Command/Event/Guard calls survive a JSON round trip unchanged',
    },
  },
  create,
} satisfies Rule;
