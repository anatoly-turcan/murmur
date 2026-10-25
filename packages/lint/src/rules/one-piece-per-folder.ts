import { basename, dirname } from 'node:path';

import { className } from '../ast.ts';
import { isPieceEntry, isPieceFile, isTestFile, pieceDir, pieceId } from '../paths.ts';
import { isPieceClass } from '../piece-shape.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

function folderOf(filename: string): string {
  return pieceDir(filename) ?? dirname(filename);
}

function secondInEntry(node: AstNode, first: string, id: string): string {
  return `pieces/${id} already declares ${first}; one folder is one piece: move ${className(node)} to its own folder (pieces/${id}/<name>/piece.ts)`;
}

function outsideEntry(node: AstNode, filename: string, id: string): string {
  return `${className(node)} extends Piece(...) in ${basename(filename)}: a piece class lives only in piece.ts, one per folder (pieces/${id})`;
}

function create(context: RuleContext): Visitors {
  const filename = context.filename;
  if (!isPieceFile(filename) || isTestFile(filename)) {
    return {};
  }

  const entry = isPieceEntry(filename);
  const id = pieceId(folderOf(filename));
  let first: string | undefined;
  const check = (node: AstNode) => {
    if (!isPieceClass(node)) {
      return;
    }

    if (!entry) {
      context.report({ node, message: outsideEntry(node, filename, id) });

      return;
    }

    if (first !== undefined) {
      context.report({ node, message: secondInEntry(node, first, id) });

      return;
    }

    first = className(node);
  };

  return { ClassDeclaration: check, ClassExpression: check };
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'a piece folder declares one piece class, in piece.ts' },
  },
  create,
} satisfies Rule;
