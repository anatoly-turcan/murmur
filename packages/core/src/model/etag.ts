import { z } from 'zod';

const QUOTED = /^"([^"]*)"$/;

function ifMatchValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();

  return QUOTED.exec(trimmed)?.[1] ?? trimmed;
}

export const IfMatch = z.preprocess(
  ifMatchValue,
  z
    .string()
    .regex(/^[^"\s,]+$/, { message: 'expected one strong ETag like "7", or *' })
    .nullable(),
);

export function etag(value: string | number): string {
  const text = String(value);

  return QUOTED.test(text) ? text : `"${text}"`;
}
