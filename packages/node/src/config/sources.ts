import { readFile } from 'node:fs/promises';

import { MurmurError } from 'murmur';
import { parse } from 'yaml';

export type RawValue = string | readonly RawValue[] | { readonly [key: string]: RawValue };
export type RawMap = Readonly<Record<string, RawValue>>;
export type Env = Readonly<Record<string, string | undefined>>;

export interface YamlConfig {
  readonly shared: RawMap;
  readonly pieces: Readonly<Record<string, RawMap>>;
  readonly capabilities: Readonly<Record<string, RawMap>>;
}

export const emptyYamlConfig: YamlConfig = Object.freeze({ shared: {}, pieces: {}, capabilities: {} });

const SECTIONS = ['shared', 'pieces', 'capabilities'];
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const QUOTE_OPENERS = new Set([undefined, ' ', '\t', ':', '[', '{', ',']);

export class ConfigSourceError extends MurmurError {
  override readonly name: string = 'ConfigSourceError';

  constructor(message: string) {
    super(message, { code: 'config-source', retryable: false });
  }
}

function commentStart(line: string): number {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
    } else if ((char === '"' || char === "'") && QUOTE_OPENERS.has(line[index - 1])) {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/.test(line[index - 1] ?? ''))) {
      return index;
    }
  }

  return line.length;
}

function interpolateLine(line: string, lineNo: number, env: Env): string {
  const cut = commentStart(line);
  const value = line.slice(0, cut).replace(VARIABLE, (_match, name: string, fallback: string | undefined) => {
    const resolved = env[name] ?? fallback;
    if (resolved === undefined) {
      throw new ConfigSourceError(`murmur.yaml line ${lineNo}: \${${name}} is not set and has no default`);
    }

    return resolved;
  });

  return value + line.slice(cut);
}

export function interpolate(text: string, env: Env): string {
  return text
    .split('\n')
    .map((line, index) => interpolateLine(line, index + 1, env))
    .join('\n');
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapAt(value: unknown, where: string): RawMap {
  if (value === undefined || value === null || value === '') {
    return {};
  }

  if (!isMap(value)) {
    throw new ConfigSourceError(`murmur.yaml: ${where} must be a map`);
  }

  return value as RawMap;
}

function nestedMaps(value: unknown, where: string): Record<string, RawMap> {
  const outer = mapAt(value, where);

  return Object.fromEntries(
    Object.entries(outer).map(([key, inner]) => [key, mapAt(inner, `${where}.${key}`)]),
  );
}

function parseText(text: string): unknown {
  try {
    return parse(text, { schema: 'failsafe' });
  } catch (error) {
    throw new ConfigSourceError(`murmur.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseYamlConfig(text: string, env: Env): YamlConfig {
  const document = mapAt(parseText(interpolate(text, env)), 'the top level');
  const unknown = Object.keys(document).filter((key) => !SECTIONS.includes(key));

  if (unknown.length > 0) {
    throw new ConfigSourceError(
      `murmur.yaml: unknown section ${unknown.join(', ')} (expected ${SECTIONS.join(', ')})`,
    );
  }

  return {
    shared: mapAt(document['shared'], 'shared'),
    pieces: nestedMaps(document['pieces'], 'pieces'),
    capabilities: nestedMaps(document['capabilities'], 'capabilities'),
  };
}

export async function readYamlConfig(file: string, env: Env): Promise<YamlConfig> {
  const text = await readFile(file, 'utf8').catch((error: unknown) => {
    if (Reflect.get(Object(error), 'code') === 'ENOENT') {
      return undefined;
    }

    throw error;
  });

  return text === undefined ? emptyYamlConfig : parseYamlConfig(text, env);
}
