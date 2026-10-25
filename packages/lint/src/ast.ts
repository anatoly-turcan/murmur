import type { AstNode } from './types.ts';

const classTypes = new Set(['ClassDeclaration', 'ClassExpression']);

export function isClass(node: AstNode | null | undefined): boolean {
  return classTypes.has(node?.type ?? '');
}

export function calleeName(node: AstNode | null | undefined): string | undefined {
  if (node?.type !== 'CallExpression' || node.callee?.type !== 'Identifier') {
    return undefined;
  }

  return node.callee.name;
}

export function decoratorName(decorator: AstNode): string | undefined {
  const expression = decorator.expression;
  const target = expression?.type === 'CallExpression' ? expression.callee : expression;

  if (target?.type === 'MemberExpression') {
    return target.property?.name;
  }

  return target?.name;
}

export function className(node: AstNode): string {
  return node.id?.name ?? 'an anonymous class';
}

export function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string';
}

export function propertyValue(node: AstNode | null | undefined, name: string): AstNode | undefined {
  if (node?.type !== 'ObjectExpression') {
    return undefined;
  }

  const property = node.properties?.find(
    (candidate) => candidate.type === 'Property' && !candidate.computed && keyName(candidate.key) === name,
  );

  return isAstNode(property?.value) ? property.value : undefined;
}

function keyName(key: AstNode | undefined): string | undefined {
  if (key?.type === 'Identifier') {
    return key.name;
  }

  return typeof key?.value === 'string' ? key.value : undefined;
}

export function listOf<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? value : [];
}

export function statementsOf(node: AstNode): readonly AstNode[] {
  const key = node.type === 'SwitchCase' ? 'consequent' : 'body';

  return listOf<AstNode>(Reflect.get(node, key));
}
