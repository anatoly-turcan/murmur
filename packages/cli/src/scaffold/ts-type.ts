import { key, tsLiteral, typeOf, type JsonSchema } from './sample.ts';

const PRIMITIVES: Readonly<Record<string, string>> = {
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  null: 'null',
};

function union(types: readonly string[]): string {
  return [...new Set(types)].join(' | ');
}

function isUnion(type: string): boolean {
  let depth = 0;
  for (const [index, char] of [...type].entries()) {
    if (char === '{' || char === '(' || char === '<') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === '>') {
      depth -= 1;
    } else if (depth === 0 && type.startsWith(' | ', index)) {
      return true;
    }
  }

  return false;
}

function arrayType(schema: JsonSchema): string {
  const item = tsTypeOf(schema.items);

  return isUnion(item) ? `(${item})[]` : `${item}[]`;
}

function objectType(schema: JsonSchema): string {
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(schema.properties ?? {}).map(
    ([name, value]) => `${key(name)}${required.has(name) ? '' : '?'}: ${tsTypeOf(value)}`,
  );

  return entries.length === 0 ? 'Record<string, never>' : `{ ${entries.join('; ')} }`;
}

function typeOfKind(schema: JsonSchema, kind: string | undefined): string {
  if (kind === 'array') {
    return arrayType(schema);
  }

  if (kind === 'object') {
    return objectType(schema);
  }

  return PRIMITIVES[kind ?? ''] ?? 'unknown';
}

function typeByKind(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) {
    return union(schema.type.map((kind) => typeOfKind(schema, kind)));
  }

  return typeOfKind(schema, typeOf(schema));
}

export function tsTypeOf(schema: JsonSchema | undefined): string {
  if (schema === undefined) {
    return 'unknown';
  }

  if (schema.const !== undefined) {
    return tsLiteral(schema.const);
  }

  if (schema.enum !== undefined) {
    return union(schema.enum.map(tsLiteral));
  }

  if (schema.anyOf !== undefined) {
    return union(schema.anyOf.map(tsTypeOf));
  }

  return typeByKind(schema);
}
