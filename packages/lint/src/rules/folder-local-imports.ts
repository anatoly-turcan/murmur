import { basename, dirname, relative } from 'node:path';

import { isRelative, onImports, resolveFrom } from '../imports.ts';
import { hasPieceEntry, isInside, pieceDir, piecesRoot } from '../paths.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

function isAncestorContracts(target: string, dir: string, pieces: string): boolean {
  const owner = dirname(target);

  return (
    basename(target) === 'contracts.ts' && owner !== pieces && isInside(pieces, owner) && isInside(owner, dir)
  );
}

function nestedPieceDir(dir: string, target: string): string | undefined {
  for (let path = target; path !== dir && isInside(dir, path); path = dirname(path)) {
    if (hasPieceEntry(path)) {
      return path;
    }
  }

  return undefined;
}

function create(context: RuleContext): Visitors {
  const dir = pieceDir(context.filename);
  const pieces = piecesRoot(context.filename);

  if (!dir || !pieces) {
    return {};
  }

  return onImports((node: AstNode, specifier: string) => {
    if (!isRelative(specifier)) {
      return;
    }

    const target = resolveFrom(context.filename, specifier);
    if (!isInside(dir, target)) {
      if (isAncestorContracts(target, dir, pieces)) {
        return;
      }

      context.report({
        node,
        message: `import "${specifier}" leaves the piece folder; pieces talk only through contracts`,
      });

      return;
    }

    const nested = nestedPieceDir(dir, target);
    if (nested) {
      context.report({
        node,
        message: `"${specifier}" belongs to the nested piece ${relative(dir, nested)}`,
      });
    }
  });
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'piece files import only their own folder (not nested pieces) and ancestor contracts.ts',
    },
  },
  create,
} satisfies Rule;
