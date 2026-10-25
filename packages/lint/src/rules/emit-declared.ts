import { propertyValue } from '../ast.ts';
import { isPieceClass } from '../piece-shape.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

function isThisEmit(node: AstNode): boolean {
  const callee = node.callee;

  return (
    callee?.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object?.type === 'ThisExpression' &&
    callee.property?.name === 'emit'
  );
}

function classEmits(context: RuleContext, node: AstNode): string[] | undefined {
  if (!isPieceClass(node)) {
    return undefined;
  }

  const declaration = node.superClass?.arguments?.[0];
  if (declaration === undefined) {
    return [];
  }

  if (declaration.type !== 'ObjectExpression') {
    return undefined;
  }

  const emits = propertyValue(declaration, 'emits');
  if (emits === undefined) {
    return [];
  }

  if (emits.type !== 'ArrayExpression') {
    return undefined;
  }

  return (emits.elements ?? []).flatMap((element) => (element ? [context.sourceCode.getText(element)] : []));
}

function classVisitors(context: RuleContext): Visitors {
  const stack: (string[] | undefined)[] = [];
  const enter = (node: AstNode) => stack.push(classEmits(context, node));
  const exit = () => stack.pop();

  return {
    ClassDeclaration: enter,
    ClassExpression: enter,
    'ClassDeclaration:exit': exit,
    'ClassExpression:exit': exit,
    CallExpression(node) {
      const declared = stack.at(-1);
      const contract = node.arguments?.[0];

      if (!declared || !contract || !isThisEmit(node)) {
        return;
      }

      const name = context.sourceCode.getText(contract);
      if (!declared.includes(name)) {
        context.report({ node, message: `this.emit(${name}) but ${name} is not in Piece({ emits })` });
      }
    },
  };
}

function create(context: RuleContext): Visitors {
  return classVisitors(context);
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'this.emit only events listed in Piece({ emits }) of its class',
    },
  },
  create,
} satisfies Rule;
