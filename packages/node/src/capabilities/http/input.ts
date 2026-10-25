import { z } from 'zod';

import { rootError } from './issues.ts';

const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type BodySource = () => Promise<Uint8Array | undefined>;

export interface InputSource {
  readonly method: string;
  readonly headers: Headers;
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly query: URLSearchParams;
  readonly body: BodySource;
}

export function hasBody(method: string): boolean {
  return BODY_METHODS.has(method);
}

function mediaType(headers: Headers): string {
  return (headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function isJsonType(type: string): boolean {
  return type === 'application/json' || type.endsWith('+json');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const reason = Error.isError(error) ? error.message : String(error);

    throw rootError('json', 'invalid_json', `body is not valid JSON: ${reason}`);
  }
}

export async function jsonBody(source: InputSource): Promise<unknown> {
  if (!hasBody(source.method)) {
    return {};
  }

  const text = new TextDecoder().decode((await source.body()) ?? new Uint8Array());
  if (text.trim() === '') {
    return {};
  }

  const type = mediaType(source.headers);
  if (!isJsonType(type)) {
    throw rootError(
      'mediaType',
      'unsupported_media_type',
      `expected application/json, got ${type || 'no content-type'}`,
    );
  }

  return parseJson(text);
}

export function definedParams(params: InputSource['params']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export type PartSpec = z.ZodObject | z.ZodRawShape;

export function objectOf(spec: PartSpec): z.ZodObject {
  return spec instanceof z.ZodType ? spec : z.object(spec);
}
