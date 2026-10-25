export interface LogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data: Record<string, unknown> | undefined;
}

export interface Log {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown> & { error?: unknown }): void;
  child(data: Record<string, unknown>): Log;
}

export interface Clock {
  now(): Temporal.Instant;
  zonedNow(tz?: string): Temporal.ZonedDateTime;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  freeze(instant: Temporal.Instant | string): Promise<void>;
  advance(ms: number): Promise<void>;
  clear(): Promise<void>;
}

export interface Ids {
  uuid(): string;
  short(): string;
}
