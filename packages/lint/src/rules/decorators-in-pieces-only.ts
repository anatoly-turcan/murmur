import { basename } from 'node:path';

import { listOf } from '../ast.ts';
import { isPieceEntry, isPieceFile, isTestFile } from '../paths.ts';
import { isPieceClass, isPortDecorator } from '../piece-shape.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

function decoratorsOf(node: AstNode): readonly AstNode[] {
  const members = listOf<AstNode>(node.body?.body);

  return [...(node.decorators ?? []), ...members.flatMap((member) => member.decorators ?? [])];
}

const elsewhere =
  '@Handle/@Serve mark the ports of a piece: put them on the piece class in pieces/<id>/piece.ts';
const offPiece = 'decorators belong only on the piece class (`extends Piece(...)`) and its methods';

function privateFileMessage(filename: string): string {
  return `decorators belong on the piece class and its methods in piece.ts, not in ${basename(filename)}; write a plain function or class here`;
}

function violation(filename: string, owner: AstNode, decorator: AstNode): string | undefined {
  if (!isPieceFile(filename)) {
    return isPortDecorator(decorator) ? elsewhere : undefined;
  }

  if (isTestFile(filename) && isPieceClass(owner)) {
    return undefined;
  }

  if (!isPieceEntry(filename)) {
    return privateFileMessage(filename);
  }

  return isPieceClass(owner) ? undefined : offPiece;
}

function create(context: RuleContext): Visitors {
  const check = (owner: AstNode) => {
    for (const decorator of decoratorsOf(owner)) {
      const message = violation(context.filename, owner, decorator);
      if (message !== undefined) {
        context.report({ node: decorator, message });
      }
    }
  };

  return { ClassDeclaration: check, ClassExpression: check };
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'decorators only on the piece class and its methods in pieces/**/piece.ts (and on fake piece classes in tests); @Handle/@Serve nowhere else',
    },
  },
  create,
} satisfies Rule;
