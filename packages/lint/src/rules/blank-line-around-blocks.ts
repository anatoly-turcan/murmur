import { isAstNode, statementsOf } from '../ast.ts';
import type { AstNode, Fix, Fixer, Rule, RuleContext, SourceCode, Visitors } from '../types.ts';

type Expectation = { readonly blank: boolean; readonly message: string };

const blockNames: Record<string, string> = {
  IfStatement: 'if',
  ForStatement: 'for',
  ForInStatement: 'for…in',
  ForOfStatement: 'for…of',
  WhileStatement: 'while',
  DoWhileStatement: 'do…while',
  TryStatement: 'try',
  SwitchStatement: 'switch',
  BlockStatement: 'block',
};

const attachableBlocks = new Set([
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'SwitchStatement',
]);

const functionBoundaries = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

const containers = ['Program', 'BlockStatement', 'StaticBlock', 'SwitchCase', 'TSModuleBlock'];

function blockName(node: AstNode): string | undefined {
  return Object.hasOwn(blockNames, node.type) ? blockNames[node.type] : undefined;
}

function isDeclaration(node: AstNode | undefined): boolean {
  return node?.type === 'VariableDeclaration';
}

function isOneLine(node: AstNode): boolean {
  return node.loc.start.line === node.loc.end.line;
}

function childNodes(node: AstNode): AstNode[] {
  return Object.entries(node)
    .filter(([key]) => key !== 'parent')
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter(isAstNode);
}

function containsAwait(node: AstNode): boolean {
  if (node.type === 'AwaitExpression') {
    return true;
  }

  if (functionBoundaries.has(node.type)) {
    return false;
  }

  return childNodes(node).some(containsAwait);
}

function isAwaitStatement(node: AstNode): boolean {
  return blockName(node) === undefined && node.type !== 'ReturnStatement' && containsAwait(node);
}

function isMultiLineAwait(node: AstNode): boolean {
  return !isOneLine(node) && isAwaitStatement(node);
}

function isOneLineAwait(node: AstNode): boolean {
  return isOneLine(node) && isAwaitStatement(node);
}

function hasBlankLineBetween(lines: readonly string[], previous: AstNode, next: AstNode): boolean {
  return lines.slice(previous.loc.end.line, next.loc.start.line - 1).some((line) => line.trim() === '');
}

function requiredMessage(previous: AstNode, next: AstNode): string | undefined {
  const nextBlock = blockName(next);
  const previousBlock = blockName(previous);
  const isReturn = next.type === 'ReturnStatement';

  if (isDeclaration(previous) && (nextBlock !== undefined || isReturn)) {
    return `blank line after the ${previous.kind} group, before the ${nextBlock ?? 'return'}`;
  }

  if (isReturn) {
    return 'blank line before return (unless it is the only statement of the block)';
  }

  if (nextBlock !== undefined) {
    return `blank line before the ${nextBlock} block`;
  }

  if (previousBlock !== undefined) {
    return `blank line after the ${previousBlock} block`;
  }

  if (isMultiLineAwait(previous) || isMultiLineAwait(next)) {
    return 'blank line around a multi-line await statement (it is its own paragraph)';
  }

  return undefined;
}

function readsDeclaredName(sourceCode: SourceCode, declaration: AstNode, block: AstNode): string | undefined {
  const [start, end] = block.range;
  const variable = sourceCode
    .getDeclaredVariables(declaration)
    .find((candidate) =>
      candidate.references.some(
        (reference) =>
          reference.isRead() &&
          reference.identifier.range[0] >= start &&
          reference.identifier.range[1] <= end,
      ),
    );

  return variable?.name;
}

function blankAfterFix(context: RuleContext, statements: readonly AstNode[], index: number): boolean {
  const previous = statements[index - 1];
  const next = statements[index];

  if (previous === undefined || next === undefined) {
    return true;
  }

  return (
    expectationAt(context, statements, index)?.blank ??
    hasBlankLineBetween(context.sourceCode.lines, previous, next)
  );
}

function isSingleDeclaration(context: RuleContext, statements: readonly AstNode[], index: number): boolean {
  const declaration = statements[index];
  if (declaration === undefined || !isDeclaration(declaration) || !isOneLine(declaration)) {
    return false;
  }

  return !isDeclaration(statements[index - 1]) || blankAfterFix(context, statements, index);
}

function attachMessage(
  context: RuleContext,
  statements: readonly AstNode[],
  index: number,
): string | undefined {
  const previous = statements[index - 1];
  const next = statements[index];

  if (previous === undefined || next === undefined || !attachableBlocks.has(next.type)) {
    return undefined;
  }

  if (!isSingleDeclaration(context, statements, index - 1)) {
    return undefined;
  }

  const name = readsDeclaredName(context.sourceCode, previous, next);
  if (name === undefined) {
    return undefined;
  }

  return `no blank line between the one-line declaration of ${name} and the ${blockName(next)} block that reads it`;
}

function forbiddenMessage(
  context: RuleContext,
  statements: readonly AstNode[],
  index: number,
): string | undefined {
  const previous = statements[index - 1];
  const next = statements[index];

  if (previous !== undefined && next !== undefined && isOneLineAwait(previous) && isOneLineAwait(next)) {
    return 'no blank line inside a run of one-line await statements (one group)';
  }

  return attachMessage(context, statements, index);
}

function expectationAt(
  context: RuleContext,
  statements: readonly AstNode[],
  index: number,
): Expectation | undefined {
  const previous = statements[index - 1];
  const next = statements[index];

  if (previous === undefined || next === undefined) {
    return undefined;
  }

  const forbidden = forbiddenMessage(context, statements, index);
  if (forbidden !== undefined) {
    return { blank: false, message: forbidden };
  }

  const required = requiredMessage(previous, next);

  return required === undefined ? undefined : { blank: true, message: required };
}

function indentationOf(sourceCode: SourceCode, node: AstNode): string {
  const line = sourceCode.lines[node.loc.start.line - 1] ?? '';

  return /^\s*/.exec(line)?.[0] ?? '';
}

function splitSameLine(sourceCode: SourceCode, previous: AstNode, next: AstNode, fixer: Fixer): Fix {
  const gap = sourceCode.text.slice(previous.range[1], next.range[0]);
  const indentation = indentationOf(sourceCode, previous);

  return fixer.replaceTextRange([previous.range[1], next.range[0]], `\n\n${indentation}${gap.trimStart()}`);
}

function insertBlankLine(sourceCode: SourceCode, previous: AstNode, next: AstNode) {
  return (fixer: Fixer): Fix => {
    if (previous.loc.end.line === next.loc.start.line) {
      return splitSameLine(sourceCode, previous, next, fixer);
    }

    const start = sourceCode.getIndexFromLoc({ line: previous.loc.end.line + 1, column: 0 });

    return fixer.insertTextBeforeRange([start, start], '\n');
  };
}

function removeBlankLines(sourceCode: SourceCode, previous: AstNode, next: AstNode) {
  return (fixer: Fixer): Fix =>
    fixer.replaceTextRange([previous.range[1], next.range[0]], `\n${indentationOf(sourceCode, next)}`);
}

function isWhitespaceBetween(sourceCode: SourceCode, previous: AstNode, next: AstNode): boolean {
  return sourceCode.text.slice(previous.range[1], next.range[0]).trim() === '';
}

function reportMissing(context: RuleContext, previous: AstNode, next: AstNode, message: string): void {
  if (hasBlankLineBetween(context.sourceCode.lines, previous, next)) {
    return;
  }

  context.report({ node: next, message, fix: insertBlankLine(context.sourceCode, previous, next) });
}

function reportExtra(context: RuleContext, previous: AstNode, next: AstNode, message: string): void {
  const { sourceCode } = context;
  if (
    !hasBlankLineBetween(sourceCode.lines, previous, next) ||
    !isWhitespaceBetween(sourceCode, previous, next)
  ) {
    return;
  }

  context.report({ node: next, message, fix: removeBlankLines(sourceCode, previous, next) });
}

function checkAt(context: RuleContext, statements: readonly AstNode[], index: number): void {
  const previous = statements[index - 1];
  const next = statements[index];
  const expectation = expectationAt(context, statements, index);

  if (previous === undefined || next === undefined || expectation === undefined) {
    return;
  }

  if (expectation.blank) {
    reportMissing(context, previous, next, expectation.message);

    return;
  }

  reportExtra(context, previous, next, expectation.message);
}

function create(context: RuleContext): Visitors {
  const check = (container: AstNode): void => {
    const statements = statementsOf(container);
    for (let index = 1; index < statements.length; index += 1) {
      checkAt(context, statements, index);
    }
  };

  return Object.fromEntries(containers.map((type) => [type, check]));
}

export default {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    docs: {
      description:
        'blank line around every block statement, after a const/let group before a block or return, before return and around a multi-line await; none between a single one-line declaration and the block that reads it, none inside a run of one-line awaits',
    },
  },
  create,
} satisfies Rule;
