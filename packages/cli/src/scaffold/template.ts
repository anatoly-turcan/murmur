import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATES = join(import.meta.dirname, '..', 'templates');

export function render(template: string, values: Readonly<Record<string, string>>): string {
  const text = readFileSync(join(TEMPLATES, template), 'utf8');

  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`template ${template}: no value for {{${key}}}`);
    }

    return value;
  });
}

export function yamlScalar(text: string): string {
  const plain = /^[A-Za-z0-9][^:#'"\n]*$/.test(text) && !text.endsWith(' ');

  return plain ? text : `'${text.replaceAll("'", "''")}'`;
}
