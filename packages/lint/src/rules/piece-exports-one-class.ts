import { className, listOf, statementsOf } from '../ast.ts';
import { isPieceEntry } from '../paths.ts';
import { isPieceClass, topLevelClass } from '../piece-shape.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

const exportTypes = new Set(['ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration']);
const onlyTheClass =
  'piece.ts exports one thing, `export class X extends Piece(...)`; move this to a private file of the folder';
const noDefault =
  'the piece class is a named export: `export class X extends Piece(...)`, not a default export';
const missing = 'piece.ts must export the piece class: `export class X extends Piece({ ... }) {}`';

function isExportedPieceClass(statement: AstNode): boolean {
  return statement.type === 'ExportNamedDeclaration' && isPieceClass(topLevelClass(statement));
}

function localPieceClasses(program: AstNode): Set<string> {
  const classes = statementsOf(program).filter(
    (statement) => statement.type === 'ClassDeclaration' && isPieceClass(statement),
  );

  return new Set(classes.map(className));
}

function reExportedPieceClass(statement: AstNode, pieceClasses: ReadonlySet<string>): string | undefined {
  if (statement.type !== 'ExportNamedDeclaration' || statement.declaration || statement.source) {
    return undefined;
  }

  const locals = listOf<AstNode>(statement.specifiers).map((specifier) => specifier.local?.name ?? '');

  return locals.find((name) => pieceClasses.has(name));
}

function reExportMessage(name: string): string {
  return `export the class where it is declared: \`export class ${name} extends Piece(...)\``;
}

function messageFor(statement: AstNode, reExported: string | undefined): string {
  if (reExported !== undefined) {
    return reExportMessage(reExported);
  }

  return statement.type === 'ExportDefaultDeclaration' ? noDefault : onlyTheClass;
}

function checkProgram(context: RuleContext, program: AstNode): void {
  const exports = statementsOf(program).filter((statement) => exportTypes.has(statement.type));
  const pieceClasses = localPieceClasses(program);
  let exportsPiece = false;

  for (const statement of exports) {
    const reExported = reExportedPieceClass(statement, pieceClasses);
    exportsPiece ||= reExported !== undefined || isExportedPieceClass(statement);

    if (!isExportedPieceClass(statement)) {
      context.report({ node: statement, message: messageFor(statement, reExported) });
    }
  }

  if (!exportsPiece) {
    context.report({ loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } }, message: missing });
  }
}

function create(context: RuleContext): Visitors {
  if (!isPieceEntry(context.filename)) {
    return {};
  }

  return {
    Program(node) {
      checkProgram(context, node);
    },
  };
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'piece.ts has exactly one export, a named `class … extends Piece(…)`; other files are free',
    },
  },
  create,
} satisfies Rule;
