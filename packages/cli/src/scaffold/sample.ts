export type JsonSchema = {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly anyOf?: readonly JsonSchema[];
  readonly format?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly exclusiveMinimum?: number;
  readonly maximum?: number;
  readonly exclusiveMaximum?: number;
};

const FORMAT_SAMPLES: Readonly<Record<string, string>> = {
  email: 'user@example.com',
  uuid: '00000000-0000-4000-8000-000000000000',
  'date-time': '2026-01-01T00:00:00Z',
  date: '2026-01-01',
  uri: 'https://example.com',
};

const STRING_SAMPLE = 'example';
const NUMBER_SAMPLE = 1;

export function typeOf(schema: JsonSchema): string | undefined {
  return Array.isArray(schema.type) ? schema.type[0] : (schema.type as string | undefined);
}

function stringSample(schema: JsonSchema): string {
  const base = FORMAT_SAMPLES[schema.format ?? ''] ?? STRING_SAMPLE;

  return base.padEnd(schema.minLength ?? 0, 'x').slice(0, schema.maxLength);
}

function lowerBound(schema: JsonSchema): number | undefined {
  if (schema.minimum !== undefined) {
    return schema.minimum;
  }

  if (schema.exclusiveMinimum !== undefined) {
    return Math.floor(schema.exclusiveMinimum) + 1;
  }

  return undefined;
}

function upperBound(schema: JsonSchema): number | undefined {
  if (schema.maximum !== undefined) {
    return schema.maximum;
  }

  if (schema.exclusiveMaximum !== undefined) {
    return Math.ceil(schema.exclusiveMaximum) - 1;
  }

  return undefined;
}

function numberSample(schema: JsonSchema): number {
  const low = lowerBound(schema);
  const high = upperBound(schema);

  if (low !== undefined && NUMBER_SAMPLE < low) {
    return low;
  }

  if (high !== undefined && NUMBER_SAMPLE > high) {
    return high;
  }

  return NUMBER_SAMPLE;
}

function arraySample(schema: JsonSchema): unknown[] {
  return Array.from({ length: schema.minItems ?? 0 }, () => sampleOf(schema.items));
}

function objectSample(schema: JsonSchema): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sampleOf(v)]));
}

export function sampleOf(schema: JsonSchema | undefined): unknown {
  if (schema === undefined) {
    return null;
  }

  if (schema.const !== undefined) {
    return schema.const;
  }

  if (schema.enum !== undefined) {
    return schema.enum[0];
  }

  if (schema.anyOf?.[0] !== undefined) {
    return sampleOf(schema.anyOf[0]);
  }

  switch (typeOf(schema)) {
    case 'string':
      return stringSample(schema);
    case 'number':
    case 'integer':
      return numberSample(schema);
    case 'boolean':
      return true;
    case 'array':
      return arraySample(schema);
    case 'object':
      return objectSample(schema);
    default:
      return null;
  }
}

export function key(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name.replaceAll("'", "\\'")}'`;
}

export function tsEntry(name: string, value: unknown): string {
  return `${key(name)}: ${tsLiteral(value)}`;
}

export function tsLiteral(value: unknown): string {
  if (typeof value === 'string') {
    return `'${value.replaceAll("'", "\\'")}'`;
  }

  if (Array.isArray(value)) {
    return `[${value.map(tsLiteral).join(', ')}]`;
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).map(([k, v]) => `${key(k)}: ${tsLiteral(v)}`);

    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }

  return String(value);
}
