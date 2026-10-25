import {
  ContractViolationError,
  MurmurError,
  parseSchemaSync,
  type Parsed,
  type PieceClass,
  type Schema,
  type SchemaIssue,
} from 'murmur';

function parsedSync(key: string, schema: Schema, value: unknown): Parsed {
  try {
    return parseSchemaSync(schema, value);
  } catch (error) {
    throw new MurmurError(`config.${key} has an async schema; use a synchronous one`, {
      retryable: false,
      cause: error,
    });
  }
}

function syncIssues(
  key: string,
  schema: Schema,
  value: unknown,
): readonly SchemaIssue[] | { value: unknown } {
  const result = parsedSync(key, schema, value);
  if (result.issues !== undefined) {
    return result.issues.map((issue) => ({ ...issue, path: [key, ...(issue.path ?? [])] }));
  }

  return { value: result.value };
}

export function pieceConfig(
  id: string,
  piece: PieceClass,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const shape = (piece.declaration.config ?? {}) as Readonly<Record<string, Schema>>;
  const issues: SchemaIssue[] = [];
  const config: Record<string, unknown> = {};

  for (const [key, schema] of Object.entries(shape)) {
    const checked = syncIssues(key, schema, values[key]);
    if ('value' in checked) {
      config[key] = checked.value;
    } else {
      issues.push(...checked);
    }
  }

  if (issues.length > 0) {
    throw new ContractViolationError(`${id}.config`, 'config', issues);
  }

  return Object.freeze(config);
}
