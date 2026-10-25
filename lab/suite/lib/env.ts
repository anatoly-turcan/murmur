import { randomBytes } from 'node:crypto';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set (see README.md)`);

  return value;
}

export const env = {
  get baseUrl(): string {
    return required('TASKWELL_BASE_URL').replace(/\/+$/, '');
  },
  receiverBind: process.env.SUITE_RECEIVER_BIND ?? '0.0.0.0',
  receiverHost: process.env.SUITE_RECEIVER_HOST ?? '127.0.0.1',
  candidateWebhookTimeoutMs: Number(process.env.SUITE_CANDIDATE_WEBHOOK_TIMEOUT_MS ?? 1000),
  candidateAuditRetentionDays: Number(process.env.SUITE_CANDIDATE_AUDIT_RETENTION_DAYS ?? 30),
  workerStopCmd: process.env.SUITE_WORKER_STOP_CMD ?? '',
  workerStartCmd: process.env.SUITE_WORKER_START_CMD ?? '',
  emailSinkPath: process.env.SUITE_EMAIL_SINK_PATH ?? '',
  requestTimeoutMs: Number(process.env.SUITE_REQUEST_TIMEOUT_MS ?? 40_000),
};

export const RUN_TOKEN = randomBytes(4).toString('hex');
