type Schema = Record<string, unknown>;

function asSchema(value: unknown): Schema {
  return typeof value === 'object' && value !== null ? (value as Schema) : {};
}

function firstType(schema: Schema): string | undefined {
  const type = schema['type'];

  return Array.isArray(type)
    ? (type.find((t) => t !== 'null') as string | undefined)
    : (type as string | undefined);
}

function sampleObject(schema: Schema, depth: number): Record<string, unknown> {
  const properties = asSchema(schema['properties']);
  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : Object.keys(properties),
  );

  return Object.fromEntries(
    Object.entries(properties)
      .filter(([key]) => required.has(key))
      .map(([key, value]) => [key, sampleFromSchema(value, depth + 1)]),
  );
}

function sampleString(schema: Schema): string {
  const format = schema['format'];
  if (format === 'uuid') {
    return '00000000-0000-4000-8000-000000000000';
  }

  if (format === 'date-time') {
    return '2026-01-01T00:00:00.000Z';
  }

  if (format === 'email') {
    return 'someone@example.com';
  }

  const min = typeof schema['minLength'] === 'number' ? schema['minLength'] : 0;

  return 'sample'.padEnd(min, 'x');
}

export function sampleFromSchema(value: unknown, depth = 0): unknown {
  const schema = asSchema(value);

  if (depth > 6) {
    return null;
  }

  if ('default' in schema) {
    return schema['default'];
  }

  if ('const' in schema) {
    return schema['const'];
  }

  if (Array.isArray(schema['enum'])) {
    return schema['enum'][0];
  }

  const variants = schema['anyOf'] ?? schema['oneOf'];
  if (Array.isArray(variants)) {
    return sampleFromSchema(variants[0], depth + 1);
  }

  const type = firstType(schema);
  if (type === 'object') {
    return sampleObject(schema, depth);
  }

  if (type === 'array') {
    return [];
  }

  if (type === 'string') {
    return sampleString(schema);
  }

  if (type === 'integer' || type === 'number') {
    return typeof schema['minimum'] === 'number' ? schema['minimum'] : 1;
  }

  if (type === 'boolean') {
    return false;
  }

  return null;
}
