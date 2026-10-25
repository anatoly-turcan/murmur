import { decoratorName, isAstNode } from '../ast.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

const readers = 'catalog, ctx and the conflict check read it from source without running it';

function isStaticLiteral(node: AstNode): boolean {
  return typeof node.value !== 'object' || node.value === null;
}

function isNegativeNumber(node: AstNode): boolean {
  return (
    node.operator === '-' && node.argument?.type === 'Literal' && typeof node.argument.value === 'number'
  );
}

function isStaticProperty(node: AstNode): boolean {
  return node.type === 'Property' && !node.computed && isStatic(node.value);
}

function isStatic(node: unknown): boolean {
  if (!isAstNode(node)) {
    return false;
  }

  switch (node.type) {
    case 'Literal':
      return isStaticLiteral(node);
    case 'Identifier':
      return true;
    case 'UnaryExpression':
      return isNegativeNumber(node);
    case 'ArrayExpression':
      return (node.elements ?? []).every(isStatic);
    case 'ObjectExpression':
      return (node.properties ?? []).every(isStaticProperty);
    default:
      return false;
  }
}

function isLiteralArgument(node: AstNode): boolean {
  return (node.type === 'Literal' || node.type === 'ObjectExpression') && isStatic(node);
}

function isBindingCall(node: AstNode | undefined): boolean {
  const callee = node?.callee;

  return (
    node?.type === 'CallExpression' &&
    callee?.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object?.type === 'Identifier' &&
    (node.arguments ?? []).every(isLiteralArgument)
  );
}

function handleProblems(context: RuleContext, call: AstNode): [AstNode, string][] {
  const [contract, options, ...rest] = call.arguments ?? [];
  const problems: [AstNode, string][] = [];

  if (contract !== undefined && contract.type !== 'Identifier') {
    const text = context.sourceCode.getText(contract);
    problems.push([contract, `@Handle(${text}): pass the contract class imported by name; ${readers}`]);
  }

  for (const extra of [options, ...rest]) {
    if (extra !== undefined && !isLiteralArgument(extra)) {
      problems.push([extra, `@Handle options must be a literal object; ${readers}`]);
    }
  }

  return problems;
}

function serveProblems(context: RuleContext, call: AstNode): [AstNode, string][] {
  const [binding, ...forwards] = call.arguments ?? [];
  const problems: [AstNode, string][] = [];

  if (binding !== undefined && !isBindingCall(binding)) {
    const text = context.sourceCode.getText(binding);
    const fix = "write it inline as token.method('/literal/path', { literal options })";
    problems.push([binding, `@Serve(${text}): ${fix}; ${readers}`]);
  }

  for (const forward of forwards) {
    if (forward.type !== 'Identifier') {
      const text = context.sourceCode.getText(forward);
      problems.push([
        forward,
        `@Serve forwards to ${text}: pass the contract class imported by name; ${readers}`,
      ]);
    }
  }

  return problems;
}

function problemsOf(context: RuleContext, decorator: AstNode): [AstNode, string][] {
  const call = decorator.expression;
  const name = decoratorName(decorator);

  if (call?.type !== 'CallExpression') {
    return [];
  }

  if (name === 'Handle') {
    return handleProblems(context, call);
  }

  return name === 'Serve' ? serveProblems(context, call) : [];
}

function create(context: RuleContext): Visitors {
  return {
    Decorator(node) {
      for (const [target, message] of problemsOf(context, node)) {
        context.report({ node: target, message });
      }
    },
  };
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        '@Handle/@Serve arguments are static: an imported class, an inline token.method(literal path, literal options)',
    },
  },
  create,
} satisfies Rule;
