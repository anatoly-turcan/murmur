import type { IncomingMessage } from 'node:http';
import { badRequest } from './errors.ts';

export const BODY_CAP = 65_536;

export interface RawBody {
  bytes: Buffer;
  size: number;
  tooLarge: boolean;
}

export function readBody(req: IncomingMessage, cap = BODY_CAP): Promise<RawBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= cap) chunks.push(chunk);
    });
    req.on('end', () => resolve({ bytes: size <= cap ? Buffer.concat(chunks) : Buffer.alloc(0), size, tooLarge: size > cap }));
    req.on('error', reject);
  });
}

export function isJsonMediaType(contentType: string | undefined): boolean {
  if (!contentType) return false;

  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

const decoder = new TextDecoder('utf-8', { fatal: true });

export function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw badRequest('malformed_json', 'The request body is not valid JSON.');
  }
}
