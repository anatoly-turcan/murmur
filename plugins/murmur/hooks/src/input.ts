import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export interface HookOptions {
  readonly debounceMs: number;
}

export interface HookEvent {
  readonly cwd: string;
  readonly session: string;
  readonly toolName: string | null;
  readonly filePath: string | null;
  readonly stopHookActive: boolean;
}

interface RawEvent {
  readonly cwd?: unknown;
  readonly session_id?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: { readonly file_path?: unknown };
  readonly stop_hook_active?: unknown;
}

const DEFAULT_DEBOUNCE_MS = 300;

export function hookOptions(argv: readonly string[]): HookOptions {
  const { values } = parseArgs({ args: [...argv], options: { 'debounce-ms': { type: 'string' } } });
  const debounceMs = Number(values['debounce-ms'] ?? DEFAULT_DEBOUNCE_MS);

  return { debounceMs: Number.isFinite(debounceMs) && debounceMs > 0 ? debounceMs : 0 };
}

function parseRaw(text: string): RawEvent | null {
  try {
    const event: unknown = JSON.parse(text);

    return typeof event === 'object' && event !== null ? (event as RawEvent) : null;
  } catch {
    return null;
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function filePathOf(raw: RawEvent, cwd: string): string | null {
  const file = raw.tool_input?.file_path;
  if (typeof file !== 'string' || file === '') {
    return null;
  }

  return isAbsolute(file) ? file : resolve(cwd, file);
}

export function hookEvent(text: string): HookEvent | null {
  const raw = parseRaw(text);
  if (raw === null) {
    return null;
  }

  const cwd = stringOr(raw.cwd, process.cwd());

  return {
    cwd,
    session: stringOr(raw.session_id, 'default'),
    toolName: typeof raw.tool_name === 'string' ? raw.tool_name : null,
    filePath: filePathOf(raw, cwd),
    stopHookActive: raw.stop_hook_active === true,
  };
}
