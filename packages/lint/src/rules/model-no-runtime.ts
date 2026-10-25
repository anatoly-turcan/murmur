import { join, resolve, sep } from 'node:path';

import { isRelative, onImports, resolveFrom } from '../imports.ts';
import { isInside } from '../paths.ts';
import type { Rule, RuleContext, Visitors } from '../types.ts';

const message =
  'model never imports runtime; declare the shape in model/ and let runtime/ implement it (§3.0)';

export function runtimeDirFor(filename: string): string | undefined {
  const parts = resolve(filename).split(sep);
  const modelAt = parts.lastIndexOf('model');

  if (modelAt <= 0) {
    return undefined;
  }

  return join(parts.slice(0, modelAt).join(sep) || sep, 'runtime');
}

function create(context: RuleContext): Visitors {
  const runtimeDir = runtimeDirFor(context.filename);
  if (!runtimeDir) {
    return {};
  }

  return onImports((node, specifier) => {
    if (isRelative(specifier) && isInside(runtimeDir, resolveFrom(context.filename, specifier))) {
      context.report({ node, message });
    }
  });
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'packages/core/src/model never imports packages/core/src/runtime, not even types' },
  },
  create,
} satisfies Rule;
