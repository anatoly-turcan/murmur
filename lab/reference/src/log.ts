import type { LogLevel } from './config.ts';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_RE = /twl_[A-Za-z0-9]{40}/g;

export function redact(text: string): string {
  return text.replace(SECRET_RE, (s) => `${s.slice(0, 12)}…`);
}

function line(level: LogLevel, component: string, msg: string, fields: LogFields): string {
  const record = { t: new Date().toISOString(), level, component, msg, ...fields };

  return redact(JSON.stringify(record, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export function createLogger(minimum: LogLevel, component: string): Logger {
  const emit = (level: LogLevel) => (msg: string, fields: LogFields = {}) => {
    if (RANK[level] < RANK[minimum]) return;
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(`${line(level, component, msg, fields)}\n`);
  };

  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) return { error: err.message, stack: err.stack };

  return { error: String(err) };
}
