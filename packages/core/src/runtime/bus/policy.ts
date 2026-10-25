import type { DeliveryPolicy, DeliveryPolicyInput, PiecePolicy, RetryPolicy } from '../../model/policy.ts';

export const DEFAULT_POLICY: DeliveryPolicy = Object.freeze({
  concurrency: 8,
  timeoutMs: 30_000,
  retry: Object.freeze({ maxAttempts: 5, baseMs: 200, maxMs: 30_000, jitter: 0.5 }),
  requestTimeoutMs: 10_000,
});

export function mergePolicy(
  base: DeliveryPolicy,
  override: DeliveryPolicyInput | PiecePolicy = {},
): DeliveryPolicy {
  return { ...base, ...override, retry: { ...base.retry, ...override.retry } };
}

export function backoff(retry: RetryPolicy, attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(retry.baseMs * 2 ** (attempt - 1), retry.maxMs);

  return Math.max(0, Math.round(exponential * (1 + retry.jitter * (random() * 2 - 1))));
}
