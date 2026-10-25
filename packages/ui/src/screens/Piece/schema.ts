type Schema = Record<string, unknown>;

function asSchema(value: unknown): Schema {
  return typeof value === 'object' && value !== null ? (value as Schema) : {};
}

export function typeLabel(value: unknown): string {
  const schema = asSchema(value);
  if (Array.isArray(schema['enum'])) {
    return schema['enum'].map((v) => JSON.stringify(v)).join(' | ');
  }

  if ('const' in schema) {
    return JSON.stringify(schema['const']);
  }

  const variants = schema['anyOf'] ?? schema['oneOf'];
  if (Array.isArray(variants)) {
    return variants.map(typeLabel).join(' | ');
  }

  const type = schema['type'];
  if (type === 'array') {
    return `${typeLabel(schema['items'])}[]`;
  }

  if (type === 'object') {
    return 'object';
  }

  if (Array.isArray(type)) {
    return type.join(' | ');
  }

  if (typeof type !== 'string') {
    return 'unknown';
  }

  return typeof schema['format'] === 'string' ? `${type} (${schema['format']})` : type;
}

export interface SchemaField {
  path: string;
  type: string;
  required: boolean;
}

export function schemaFields(value: unknown, prefix = ''): SchemaField[] {
  const schema = asSchema(value);
  const properties = asSchema(schema['properties']);
  const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : []);

  return Object.entries(properties).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const nested = asSchema(child)['type'] === 'object' ? schemaFields(child, path) : [];

    return [{ path, type: typeLabel(child), required: required.has(key) }, ...nested];
  });
}
