import { basename } from 'node:path';

import { isPieceFile, pieceDir } from '../paths.ts';
import type { Rule, RuleContext, Visitors } from '../types.ts';

const allowed = new Set(['contracts.ts', 'scenario.test.ts']);
const groupOnly =
  'group folders hold only context.md, contracts.ts and scenario.test.ts; code belongs in a piece folder';
const strayTest = 'piece.test.ts needs a piece.ts beside it; a subtree test is scenario.test.ts';

function create(context: RuleContext): Visitors {
  const name = basename(context.filename);
  if (!isPieceFile(context.filename) || allowed.has(name) || pieceDir(context.filename)) {
    return {};
  }

  const message = name === 'piece.test.ts' ? strayTest : groupOnly;

  return { Program: (node) => context.report({ node, message }) };
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'group folders hold only contracts.ts and scenario.test.ts code' },
  },
  create,
} satisfies Rule;
