export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  databaseUrl: string;
  bind: string;
  port: number;
  testMode: boolean;
  emailSinkPath: string | null;
  webhookTimeoutMs: number;
  trustProxy: boolean;
  logLevel: LogLevel;
  auditRetentionDays: number;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function flag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer, got ${value}`);

  return parsed;
}

function logLevel(value: string | undefined): LogLevel {
  const level = (value ?? 'info').trim().toLowerCase() as LogLevel;

  return LOG_LEVELS.includes(level) ? level : 'info';
}

function required(value: string | undefined, name: string): string {
  if (!value || value.trim() === '') throw new Error(`${name} is required`);

  return value.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: required(env.TASKWELL_DATABASE_URL, 'TASKWELL_DATABASE_URL'),
    bind: env.TASKWELL_BIND?.trim() || '0.0.0.0',
    port: positiveInt(env.TASKWELL_PORT, 8080, 'TASKWELL_PORT'),
    testMode: flag(env.TASKWELL_TEST_MODE),
    emailSinkPath: env.TASKWELL_EMAIL_SINK_PATH?.trim() || null,
    webhookTimeoutMs: positiveInt(env.TASKWELL_WEBHOOK_TIMEOUT_MS, 5000, 'TASKWELL_WEBHOOK_TIMEOUT_MS'),
    trustProxy: flag(env.TASKWELL_TRUST_PROXY),
    logLevel: logLevel(env.TASKWELL_LOG_LEVEL),
    auditRetentionDays: positiveInt(env.TASKWELL_AUDIT_RETENTION_DAYS, 365, 'TASKWELL_AUDIT_RETENTION_DAYS'),
  };
}
