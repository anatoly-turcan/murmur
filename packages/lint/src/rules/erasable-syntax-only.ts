import { isPieceFile } from '../paths.ts';
import { isPortDecorator } from '../piece-shape.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

const message =
  'not erasable: Node strips types only; use a const object + union / a module / a plain property';

function create(context: RuleContext): Visitors {
  const reject = (node: AstNode) => context.report({ node, message });
  const rejectUnlessDeclared = (node: AstNode) => {
    if (!node.declare) {
      reject(node);
    }
  };
  const visitors: Visitors = {
    TSEnumDeclaration: rejectUnlessDeclared,
    TSModuleDeclaration: rejectUnlessDeclared,
    TSParameterProperty: reject,
    TSImportEqualsDeclaration: reject,
  };

  if (isPieceFile(context.filename)) {
    return visitors;
  }

  const rejectUnlessPort = (node: AstNode) => {
    if (!isPortDecorator(node)) {
      reject(node);
    }
  };

  return { ...visitors, Decorator: rejectUnlessPort };
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'only erasable TypeScript: no enum, namespace, parameter properties; decorators only in piece files (the loader lowers them; misplaced @Handle/@Serve are reported by decorators-in-pieces-only)',
    },
  },
  create,
} satisfies Rule;
