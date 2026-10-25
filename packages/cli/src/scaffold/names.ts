import { join } from 'node:path';

import { usageError } from '../errors.ts';

export const CONFIG_TYPES: Readonly<Record<string, string>> = {
  string: 'z.string()',
  number: 'z.number()',
  boolean: 'z.boolean()',
  url: 'z.url()',
};

export const CONFIG_STUBS: Readonly<Record<string, string>> = {
  string: "'example'",
  number: '1',
  boolean: 'true',
  url: "'https://example.com'",
};

export const BUILTIN_CAPABILITIES: ReadonlySet<string> = new Set(['sqlite', 'kv', 'fetch', 'jobs']);

export interface KeyType {
  readonly key: string;
  readonly type: string;
}

export function parseKeyTypes(list: readonly string[], flagName: string): KeyType[] {
  return list.map((item) => {
    const [key = '', type = 'string'] = item.split(':').map((s) => s.trim());
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
      throw usageError(`--${flagName}: "${item}" needs key:type`);
    }

    if (CONFIG_TYPES[type] === undefined) {
      throw usageError(
        `--${flagName}: type "${type}" must be one of ${Object.keys(CONFIG_TYPES).join(', ')}`,
      );
    }

    return { key, type };
  });
}

export function pascalName(name: string): string {
  return name
    .split(/[.-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function camelName(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

export function kebabName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export function pieceDir(root: string, id: string): string {
  return join(root, 'pieces', id);
}

export function laneLine(lane: string, names: readonly string[]): string {
  return `${lane}: ${names.length === 0 ? 'none' : names.join(', ')}`;
}
