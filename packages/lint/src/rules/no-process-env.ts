import { basename, sep } from 'node:path';

import { isTestFile } from '../paths.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

const message =
  'process.env is forbidden here; declare the key in `Piece({ config: { apiUrl: z.string() } })` and read `this.config.apiUrl` (set by murmur.yaml or MURMUR__<PIECE>__API_URL); a capability reads its own config';

function isExempt(filename: string): boolean {
  const name = basename(filename);

  return name === 'murmur.config.ts' || isTestFile(name) || filename.split(sep).includes('capabilities');
}

function propertyName(node: AstNode): string | undefined {
  const property = node.property;
  if (!property) {
    return undefined;
  }

  if (!node.computed) {
    return property.name;
  }

  return typeof property.value === 'string' ? property.value : undefined;
}

function isProcess(node: AstNode | undefined): boolean {
  if (node?.type === 'Identifier') {
    return node.name === 'process';
  }

  return (
    node?.type === 'MemberExpression' &&
    node.object?.type === 'Identifier' &&
    node.object.name === 'globalThis' &&
    propertyName(node) === 'process'
  );
}

function isImportMeta(node: AstNode | undefined): boolean {
  return node?.type === 'MetaProperty' && node.meta?.name === 'import' && node.property?.name === 'meta';
}

function create(context: RuleContext): Visitors {
  if (isExempt(context.filename)) {
    return {};
  }

  return {
    MemberExpression(node) {
      if (propertyName(node) !== 'env') {
        return;
      }

      if (isProcess(node.object) || isImportMeta(node.object)) {
        context.report({ node, message });
      }
    },
  };
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'configuration flows through the config lane, never process.env' },
  },
  create,
} satisfies Rule;
