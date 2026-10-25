import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

const message = 'class method without a return type: declare it (`: Promise<Todo | null>`, `: void`)';
const TYPED_KINDS = new Set(['method', 'get']);

function lacksReturnType(method: AstNode): boolean {
  const fn = method.value as AstNode | undefined;

  return TYPED_KINDS.has(method.kind ?? '') && fn?.returnType == null;
}

function create(context: RuleContext): Visitors {
  function check(node: AstNode): void {
    if (lacksReturnType(node)) {
      context.report({ node: node.key ?? node, message });
    }
  }

  return { MethodDefinition: check, TSAbstractMethodDefinition: check };
}

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'every class method and getter declares its return type, private and #private included',
    },
  },
  create,
} satisfies Rule;
