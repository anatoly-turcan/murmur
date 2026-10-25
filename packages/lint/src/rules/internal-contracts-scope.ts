import { dirname, relative, sep } from 'node:path';

import { isBare, onImports, resolveFrom } from '../imports.ts';
import { isGroupContracts, isInside, piecesRoot } from '../paths.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

function importedNames(node: AstNode): string[] {
  return (node.specifiers ?? []).flatMap((specifier) => {
    const name = specifier.imported?.name ?? specifier.local?.name;

    return name && name !== 'default' ? [name] : [];
  });
}

function subject(node: AstNode, groupPath: string): string {
  const names = importedNames(node);

  return names.length > 0 ? names.join(', ') : `${groupPath}/contracts.ts`;
}

function create(context: RuleContext): Visitors {
  return onImports((node, specifier) => {
    if (isBare(specifier)) {
      return;
    }

    const target = resolveFrom(context.filename, specifier);
    if (!isGroupContracts(target)) {
      return;
    }

    const group = dirname(target);
    if (isInside(group, context.filename)) {
      return;
    }

    const pieces = piecesRoot(target) ?? group;
    const groupPath = ['pieces', ...relative(pieces, group).split(sep)].join('/');
    const message = `${subject(node, groupPath)} is internal to ${groupPath}; move it to contracts/ to make it public`;
    context.report({ node, message });
  });
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'pieces/<group>/contracts.ts is importable only from inside pieces/<group>/' },
  },
  create,
} satisfies Rule;
