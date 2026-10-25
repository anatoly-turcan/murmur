import { calleeName, decoratorName, isClass } from './ast.ts';
import type { AstNode } from './types.ts';

const portDecorators = new Set(['Handle', 'Serve']);

export function isPieceClass(node: AstNode | null | undefined): boolean {
  return isClass(node) && calleeName(node?.superClass) === 'Piece';
}

export function topLevelClass(statement: AstNode): AstNode | undefined {
  const candidate = statement.type === 'ClassDeclaration' ? statement : statement.declaration;

  return isClass(candidate) ? (candidate ?? undefined) : undefined;
}

export function isPortDecorator(decorator: AstNode): boolean {
  return portDecorators.has(decoratorName(decorator) ?? '');
}
