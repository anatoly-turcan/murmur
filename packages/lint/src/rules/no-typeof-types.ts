import { isPieceFile } from '../paths.ts';
import type { Rule, RuleContext, Visitors } from '../types.ts';

function create(context: RuleContext): Visitors {
  if (!isPieceFile(context.filename)) {
    return {};
  }

  return {
    TSTypeQuery(node) {
      const text = context.sourceCode.getText(node);
      const message = `${text} in a type: name the class (input: CreateTodo, Promise<Todo>) or a type exported next to its value`;
      context.report({ node, message });
    },
  };
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'no `typeof X` types in piece code; contract classes are their own types',
    },
  },
  create,
} satisfies Rule;
