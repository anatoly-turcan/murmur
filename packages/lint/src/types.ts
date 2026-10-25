export interface Position {
  readonly line: number;
  readonly column: number;
}

export interface Location {
  readonly start: Position;
  readonly end: Position;
}

export interface AstNode {
  readonly type: string;
  readonly range: readonly [number, number];
  readonly loc: Location;
  readonly parent?: AstNode;
  readonly name?: string;
  readonly value?: unknown;
  readonly kind?: string;
  readonly operator?: string;
  readonly declare?: boolean;
  readonly computed?: boolean;
  readonly id?: AstNode | null;
  readonly key?: AstNode;
  readonly object?: AstNode;
  readonly property?: AstNode;
  readonly meta?: AstNode;
  readonly callee?: AstNode;
  readonly argument?: AstNode | null;
  readonly arguments?: readonly AstNode[];
  readonly expression?: AstNode;
  readonly superClass?: AstNode | null;
  readonly decorators?: readonly AstNode[];
  readonly elements?: readonly (AstNode | null)[];
  readonly properties?: readonly AstNode[];
  readonly source?: AstNode | null;
  readonly specifiers?: readonly AstNode[];
  readonly imported?: AstNode;
  readonly local?: AstNode;
  readonly declaration?: AstNode | null;
  readonly body?: AstNode;
  readonly returnType?: AstNode | null;
}

export interface Comment {
  readonly value: string;
  readonly range: readonly [number, number];
  readonly loc: Location;
}

export interface Reference {
  readonly identifier: AstNode;
  isRead(): boolean;
}

export interface Variable {
  readonly name: string;
  readonly references: readonly Reference[];
}

export interface SourceCode {
  readonly text: string;
  readonly lines: readonly string[];
  getText(node: AstNode): string;
  getCommentsInside(node: AstNode): Comment[];
  getIndexFromLoc(loc: Position): number;
  getDeclaredVariables(node: AstNode): readonly Variable[];
  readonly scopeManager: { readonly globalScope: { readonly through: readonly Reference[] } | null };
}

export interface Fix {
  readonly range: readonly [number, number];
  readonly text: string;
}

export interface Fixer {
  insertTextAfter(node: AstNode, text: string): Fix;
  insertTextBeforeRange(range: readonly [number, number], text: string): Fix;
  replaceTextRange(range: readonly [number, number], text: string): Fix;
}

type Target = { node: AstNode } | { loc: Location };

export type Report = Target & { message: string; fix?: (fixer: Fixer) => Fix };

export interface RuleContext {
  readonly filename: string;
  readonly options: readonly unknown[];
  readonly sourceCode: SourceCode;
  report(report: Report): void;
}

export type Visitors = Record<string, (node: AstNode) => void>;

export interface Rule {
  readonly meta: {
    readonly type: 'problem' | 'suggestion' | 'layout';
    readonly docs: { readonly description: string };
    readonly fixable?: 'code' | 'whitespace';
    readonly deprecated?: boolean;
    readonly schema?: readonly unknown[];
  };
  create(context: RuleContext): Visitors;
}
