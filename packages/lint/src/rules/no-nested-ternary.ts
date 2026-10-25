import type { Rule, RuleContext, Visitors } from '../types.ts';

const message = 'nested ternary: make the outer choice an if block, or name the inner value first';

function create(context: RuleContext): Visitors {
  let depth = 0;

  return {
    ConditionalExpression(node) {
      if (depth > 0) {
        context.report({ node, message });
      }

      depth += 1;
    },
    'ConditionalExpression:exit'() {
      depth -= 1;
    },
  };
}

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'no ternary inside another ternary, parenthesised or not',
    },
  },
  create,
} satisfies Rule;
