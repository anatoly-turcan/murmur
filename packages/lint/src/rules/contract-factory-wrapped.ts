import { calleeName, isClass, propertyValue } from '../ast.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

const optionsIndex: Record<string, number> = { Query: 2, Command: 2, Event: 1, Guard: 1 };

function factoryImports(node: AstNode): [string, string][] {
  if (node.source?.value !== 'murmur') {
    return [];
  }

  return (node.specifiers ?? []).flatMap((specifier) => {
    const imported = specifier.imported?.name;
    const local = specifier.local?.name;
    const isFactory =
      specifier.type === 'ImportSpecifier' && imported !== undefined && Object.hasOwn(optionsIndex, imported);

    return isFactory && local !== undefined ? [[local, imported]] : [];
  });
}

function isExtendsPosition(node: AstNode): boolean {
  return isClass(node.parent) && node.parent?.superClass === node;
}

function passesName(node: AstNode, kind: string): boolean {
  return propertyValue(node.arguments?.[optionsIndex[kind] ?? -1], 'name') !== undefined;
}

function create(context: RuleContext): Visitors {
  const factories = new Map<string, string>();

  return {
    ImportDeclaration(node) {
      for (const [local, kind] of factoryImports(node)) {
        factories.set(local, kind);
      }
    },
    CallExpression(node) {
      const kind = factories.get(calleeName(node) ?? '');
      if (kind === undefined || isExtendsPosition(node) || passesName(node, kind)) {
        return;
      }

      context.report({
        node,
        message: `${kind}(...) outside \`class X extends ${kind}(...)\` has no class name to derive the wire name from (a wrapper would name it after its own file): pass { name: 'domain.Name' } or write \`class X extends ${kind}(...)\``,
      });
    },
  };
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'a Query/Command/Event/Guard call outside the extends clause of a class passes { name } (wrappers would name contracts after their own file)',
    },
  },
  create,
} satisfies Rule;
