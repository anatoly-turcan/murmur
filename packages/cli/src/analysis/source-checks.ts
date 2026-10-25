import { readFileSync } from 'node:fs';

export function readSource(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
