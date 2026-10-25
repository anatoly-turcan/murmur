import type { AstNode, Comment, Rule, RuleContext, Visitors } from '../types.ts';

const message = 'comment inside a function body; move the knowledge to context.md or into a name';
const directives = ['oxlint-', 'eslint-', '@ts-', 'c8', 'v8'];

function isDirective(comment: Comment): boolean {
  const text = comment.value.replace(/^[\s*]+/, '');

  return directives.some((directive) => text.startsWith(directive));
}

function create(context: RuleContext): Visitors {
  const reported = new Set<number>();
  const check = (node: AstNode) => {
    if (node.body?.type !== 'BlockStatement') {
      return;
    }

    for (const comment of context.sourceCode.getCommentsInside(node.body)) {
      if (isDirective(comment) || reported.has(comment.range[0])) {
        continue;
      }

      reported.add(comment.range[0]);
      context.report({ loc: comment.loc, message });
    }
  };

  return { FunctionDeclaration: check, FunctionExpression: check, ArrowFunctionExpression: check };
}

export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'no comments inside function bodies; knowledge lives in names and context.md' },
  },
  create,
} satisfies Rule;
