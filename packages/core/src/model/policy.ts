export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  jitter: number;
}

export interface DeliveryPolicy {
  concurrency: number;
  timeoutMs: number;
  retry: RetryPolicy;
  requestTimeoutMs: number;
}

export interface PiecePolicy {
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
}

export interface DeliveryPolicyInput extends PiecePolicy {
  readonly requestTimeoutMs?: number;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
