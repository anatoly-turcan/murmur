import type { RetryPolicy } from './policy.ts';

export type Duration = `${number}${'s' | 'm' | 'h' | 'd'}`;

export interface JobRetry {
  readonly attempts: number;
  readonly after?: readonly Duration[];
}

export interface HandleOptions {
  readonly every?: Duration;
  readonly retry?: JobRetry;
}

export interface JobTarget {
  readonly contract: string;
  readonly piece: string;
  readonly timeoutMs: number;
  readonly retry: JobRetry | undefined;
  readonly policyRetry: RetryPolicy;
  readonly every: Duration | undefined;
}

export interface JobInvokeInit {
  readonly id: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

const DURATION = /^([1-9]\d*)(s|m|h|d)$/;

const UNIT_MS: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function durationMs(text: unknown): number | undefined {
  const match = typeof text === 'string' ? DURATION.exec(text) : null;
  if (match === null) {
    return undefined;
  }

  return Number(match[1]) * (UNIT_MS[match[2] ?? 's'] ?? 1000);
}

export function everyFormatProblem(every: unknown): string | undefined {
  if (durationMs(every) !== undefined) {
    return undefined;
  }

  return `\`every: '${String(every)}'\` is not a duration; use \`<n>s\`, \`<n>m\`, \`<n>h\` or \`<n>d\``;
}

export function kindLabel(kind: string): string {
  return `${kind === 'event' ? 'an' : 'a'} ${kind}`;
}

export function everyInputProblem(
  contract: string,
  kind: string,
  requiredFields: boolean,
): string | undefined {
  if (kind !== 'command') {
    return `\`@Handle(${contract}, { every })\`: ${contract} is ${kindLabel(kind)}; a schedule enqueues a Command with no required input fields`;
  }

  if (requiredFields) {
    return `\`@Handle(${contract}, { every })\`: ${contract} has required input fields; a scheduled command takes none`;
  }

  return undefined;
}

export function retryKindProblem(contract: string, kind: string): string | undefined {
  if (kind === 'command') {
    return undefined;
  }

  return `\`@Handle(${contract}, { retry })\`: ${contract} is ${kindLabel(kind)}; a retry ladder applies to job Commands (policy.retry covers bus redelivery)`;
}

function badEntry(after: unknown): string | undefined {
  if (!Array.isArray(after)) {
    return JSON.stringify(after) ?? String(after);
  }

  if (after.length === 0) {
    return '[]';
  }

  const bad: unknown = after.find((entry) => durationMs(entry) === undefined);

  return bad === undefined ? undefined : (JSON.stringify(bad) ?? String(bad));
}

export function retryLadderProblem(retry: unknown): string | undefined {
  const attempts: unknown = Reflect.get(Object(retry), 'attempts');
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1) {
    return `\`retry.attempts\` must be a positive integer like \`{ attempts: 5, after: ['30s', '5m'] }\`; got ${String(attempts)}`;
  }

  const after: unknown = Reflect.get(Object(retry), 'after');
  if (after === undefined) {
    return undefined;
  }

  const bad = badEntry(after);
  if (bad === undefined) {
    return undefined;
  }

  return `\`retry.after\` entries must be durations like '30s'; got ${bad}`;
}
