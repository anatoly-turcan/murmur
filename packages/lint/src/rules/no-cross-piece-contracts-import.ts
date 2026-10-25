import { basename, extname } from 'node:path';

import { isRelative, onImports } from '../imports.ts';
import { isPieceFile } from '../paths.ts';
import type { Rule, RuleContext, Visitors } from '../types.ts';

function create(context: RuleContext): Visitors {
  if (!isPieceFile(context.filename)) {
    return {};
  }

  return onImports((node, specifier) => {
    if (!isRelative(specifier) || !specifier.includes('/contracts/')) {
      return;
    }

    const domain = basename(specifier, extname(specifier));
    context.report({ node, message: `import contracts via #contracts/${domain}, never by relative path` });
  });
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'public contracts are imported via #contracts/*, never by relative path' },
  },
  create,
} satisfies Rule;
