const CLOSERS: Readonly<Record<string, string>> = { "'": "'", '"': '"', '`': '`', '[': ']' };
const NAME = (table: string) => `(?:\\w+\\.)?["\`[]?${table}["\`\\]]?`;
const TS_LITERAL =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
const SQL_START = /^\s*(?:CREATE|ALTER|INSERT)\b/i;

function skipTo(sql: string, from: number, end: string): number {
  const at = sql.indexOf(end, from);

  return at === -1 ? sql.length : at + end.length - 1;
}

function endOfToken(sql: string, i: number): number {
  const char = sql[i] as string;
  if (char === '-' && sql[i + 1] === '-') {
    return skipTo(sql, i, '\n');
  }

  if (char === '/' && sql[i + 1] === '*') {
    return skipTo(sql, i + 2, '*/');
  }

  const closer = CLOSERS[char];

  return closer === undefined ? i : skipTo(sql, i + 1, closer);
}

export function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export function sqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;

  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === ';') {
      statements.push(sql.slice(start, i));
      start = i + 1;
    } else {
      i = endOfToken(sql, i);
    }
  }

  statements.push(sql.slice(start));

  return statements.map((s) => s.trim()).filter((s) => withoutComments(s).trim() !== '');
}

function definesOrAlters(statement: string, table: string): boolean {
  const name = NAME(table);
  const patterns = [
    `^CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}[\\s(]`,
    `^ALTER\\s+TABLE\\s+${name}\\s`,
    `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\\S+\\s+ON\\s+${name}[\\s(]`,
  ];
  const text = withoutComments(statement).trim();

  return patterns.some((p) => new RegExp(p, 'i').test(text));
}

export function statementsFor(statements: readonly string[], table: string): string[] {
  return statements.filter((s) => definesOrAlters(s, table));
}

export function createsTable(statements: readonly string[], table: string): boolean {
  return statementsFor(statements, table).some((s) =>
    /^CREATE\s+(?:TEMP\w*\s+)?TABLE/i.test(withoutComments(s).trim()),
  );
}

export function sqlStringsIn(source: string): string[] {
  return [...source.matchAll(TS_LITERAL)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .filter((text): text is string => text !== undefined && !text.includes('${') && SQL_START.test(text));
}

function hasLiteralValuesOnly(statement: string): boolean {
  return !/\?|[:@$][A-Za-z_]/.test(statement.replace(/'(?:[^']|'')*'/g, "''"));
}

export function exampleRowIn(sqls: readonly string[], table: string): string | null {
  const insert = new RegExp(`^INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${NAME(table)}[\\s(]`, 'i');

  return sqls.flatMap(sqlStatements).find((s) => insert.test(s) && hasLiteralValuesOnly(s)) ?? null;
}
